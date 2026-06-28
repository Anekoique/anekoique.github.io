---
date: '2026-06-27T12:00:00+08:00'
draft: false
title: 'Virtualization Systems — Docker'
slug: 'docker'
tags: ["Virtualization", "Systems", "Containers", "Docker", "Linux"]
series: ["Virtualization Series"]
summary: "The canonical OS-level virtualization stack: containers as host processes restricted by namespaces, cgroups, seccomp, capabilities, OverlayFS, and netfilter. Full walk from Docker Engine to containerd to runc to kernel features."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

Docker is the canonical **OS-level virtualization** stack: it runs guests as ordinary host processes whose view of the system has been narrowed by kernel features (namespaces, cgroups, seccomp, capabilities, OverlayFS, netfilter). It is *not* a hypervisor — there is no virtual CPU, no virtual MMU, no virtual hardware. The "container" is a host process running directly on the host kernel, with restricted visibility and resource caps. Initially released by dotCloud in 2013 as a monolithic Go daemon wrapping LXC, Docker drove the standardization of the **OCI** (Open Container Initiative) image format (2015) and the **OCI runtime** spec, after which it factored into a layered stack: Docker Engine (`moby/moby`) → containerd (`containerd/containerd`) → runc (`opencontainers/runc`) → Linux kernel features.

What makes Docker worth reading in a virtualization survey — and what makes it different from every other system in this directory — is that **Docker's isolation mechanism is the host kernel itself**, not a hypervisor mediating a virtual machine. Reading Docker shows what falls out of the [§02](/virtualization/taxonomy/) isolation-boundary axis when "isolation" is realized by *kernel feature flags* rather than by *hardware privilege separation* or *language types*. The trade-off this exposes — stronger isolation costs more per call; weaker isolation requires more shared trust — is the same one Astervisor will face.

This note deliberately departs from the chapter template the hypervisor notes follow. Docker has no vCPU, no memory model, no exit handler, no cross-domain communication mechanism — forcing §04–§08 onto it produces empty sections that misrepresent what it is. The structure below is shaped to Docker's actual architecture: a layered stack of orchestrators on top of a substrate of composable kernel primitives. Source citations name canonical paths: `runc/libcontainer/`, `containerd/`, `moby/daemon/`, and Linux kernel paths under `kernel/`, `mm/`, `fs/`, `net/`, `security/`. No pinned commit; paths are stable across recent releases.

## §02 — Taxonomy: Docker at a glance

| Axis | Docker |
|---|---|
| Placement | **OS-level virtualization** — no VMM in the §02 sense. The "VMM" is the host Linux kernel; containers are host processes with restricted views |
| Guest interface | **Identical to the host kernel ABI** — guest sees Linux syscalls because it *is* on Linux. No paravirt, no full virt, no instruction translation |
| Hardware support | None required for isolation. CPU virtualization extensions unused. Some optional features (CRIU for checkpoint, eBPF for filtering) use kernel-specific facilities |
| Isolation boundary | **Software (kernel feature flags)**: namespaces (visibility), cgroups (resources), seccomp (syscall filter), capabilities (privilege filter), MAC (SELinux/AppArmor). All guests share *one* kernel |

The defining structural choice is **shared kernel**. Every container on a host runs against the *same* `task_struct`-scheduled, `mm_struct`-managed, `ext4`/`overlayfs`-served Linux kernel. The kernel sees containers as ordinary processes — they appear in `ps` on the host (with cgroup tags), use ordinary file descriptors, are scheduled by ordinary CFS. The "containment" is entirely a matter of *which* `task_struct` fields point at *which* namespace structures, and *which* cgroup the task belongs to.

Three rules to internalize before any details:

1. **The shared kernel is the entire TCB.** Every line of Linux is trusted with respect to every container. Container escapes are kernel CVEs. There is no second layer of defense — by design.
2. **Performance is near-native because there is no virtualization layer.** Container creation is `clone()` with flags; container memory is host memory; container CPU is host CPU under CFS. No second-stage paging, no VM-exits, no soft-MMU.
3. **"Docker" today is mostly orchestration on top of standards Docker itself drove.** The interesting low-level work is in **runc** (~30 KLoC Go) and the **kernel features** (~50 KLoC across `kernel/cgroup/`, `kernel/nsproxy.c`, `fs/namespace.c`, etc.). The Docker daemon and containerd are control planes; the actual isolation happens in the kernel.

## The stack

Modern Docker is a four-layer stack. Each layer was extracted from a monolithic predecessor over the 2014–2020 period, driven by the OCI standardization effort. The split is now stable and is the structure to learn.

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Docker Engine (dockerd) — REST API, image mgmt, CLI server      │
   └───────────────────────────────┬──────────────────────────────────┘
                                   │ gRPC
   ┌───────────────────────────────▼──────────────────────────────────┐
   │  containerd — container lifecycle, snapshots, image distribution │
   └───────────────────────────────┬──────────────────────────────────┘
                                   │ shim + OCI runtime spec (JSON)
   ┌───────────────────────────────▼──────────────────────────────────┐
   │  runc — translate OCI spec into clone()+setns()+cgroup writes    │
   └───────────────────────────────┬──────────────────────────────────┘
                                   │ syscalls
   ┌───────────────────────────────▼──────────────────────────────────┐
   │  Linux kernel — namespaces, cgroups, seccomp, capabilities,      │
   │  OverlayFS, netfilter, LSM (SELinux/AppArmor)                    │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼  scheduled on real hardware
                              physical CPU(s), RAM, devices
```

What each layer owns:

| Layer | Code | Responsibility |
|---|---|---|
| Linux kernel | `kernel/`, `mm/`, `fs/overlayfs/`, `net/netfilter/`, `security/` | Isolation primitives. Everything else delegates here for actual enforcement |
| runc | `runc/libcontainer/` (~30 KLoC Go + thin C) | OCI runtime reference. Translates a JSON spec into `clone()` + cgroup writes + namespace setup + seccomp install. One-shot, stateless |
| containerd | `containerd/` (~150 KLoC Go) | Long-running daemon. Manages running containers via per-container shim processes; handles image pull/store; serves Kubernetes' CRI |
| Docker Engine | `moby/daemon/` (~600 KLoC Go w/ vendoring) | User-facing daemon. REST API, CLI server, image builder, networks, volumes, plugins |

The pattern: **the kernel does the isolation; each higher layer adds vocabulary the next-higher layer uses.** Kubernetes today talks gRPC to containerd *directly* (no Docker daemon involved) — the Docker Engine is the *origin story* of the stack, not a runtime dependency.

The reading order in the rest of this note follows the stack bottom-up: substrate → runtime → orchestrator → daemon. This mirrors both dependency direction and how a container actually gets created (you can't start a container without the kernel; you can't manage many containers without containerd; you don't need dockerd at all on a Kubernetes node).

---

## The kernel substrate

Five composable kernel features, each independent in origin and design, together producing what we call a container. None is unique to Docker; every OCI runtime uses the same primitives.

### Namespaces — *what the container sees*

Code in `kernel/nsproxy.c`, `kernel/pid_namespace.c`, `net/core/net_namespace.c`, `fs/namespace.c` (mount), `ipc/namespace.c`, `kernel/utsname.c`, `kernel/user_namespace.c`, `kernel/time_namespace.c`, `kernel/cgroup/namespace.c`. Eight namespace kinds as of recent kernels:

| Namespace | What it isolates | Created by `clone(CLONE_*)` |
|---|---|---|
| **mount** | The filesystem tree visible to the process | `CLONE_NEWNS` |
| **PID** | Process IDs; PID 1 in the container is unrelated to host PID 1 | `CLONE_NEWPID` |
| **network** | Network interfaces, routes, firewall rules, sockets | `CLONE_NEWNET` |
| **IPC** | System V IPC objects, POSIX message queues | `CLONE_NEWIPC` |
| **UTS** | Hostname and NIS domain | `CLONE_NEWUTS` |
| **user** | UID/GID mappings; container UID 0 can map to host UID 100000 | `CLONE_NEWUSER` |
| **cgroup** | Which cgroup the process *thinks* it's in (vs. its real cgroup) | `CLONE_NEWCGROUP` |
| **time** | `CLOCK_BOOTTIME` and `CLOCK_MONOTONIC` offsets | `CLONE_NEWTIME` |

A process's `task_struct.nsproxy` points at a `struct nsproxy` holding pointers to each namespace it's a member of. Children inherit by default; `clone()` with one of the `CLONE_NEW*` flags creates new instances; `setns(fd, nstype)` joins an existing one (used by `docker exec` to enter a running container's namespaces).

**The crucial property: namespaces virtualize *names*, not *enforcement*.** A PID namespace hides host PIDs from the container, but the container's processes still exist on the host's runqueue, scheduled by the host's CFS. The kernel uses the namespace to *translate* names when a process queries (e.g., `getpid()` returns the per-namespace PID); it doesn't isolate at the resource level.

The mount namespace is the most powerful — combined with `pivot_root`, it gives the chroot-like illusion of a private rootfs. The user namespace is the most security-critical — it's what enables *unprivileged containers* where the container's UID 0 maps to an unprivileged host UID.

### cgroups — *what the container can use*

Code in `kernel/cgroup/cgroup.c`, `kernel/sched/cpu.c`, `mm/memcontrol.c`. cgroups (v2 since kernel 4.5; v1 still supported) impose resource limits on groups of processes.

| Controller | What it limits | Sysfs interface |
|---|---|---|
| `cpu` | CPU bandwidth (quota/period), priority (weight) | `cpu.max`, `cpu.weight` |
| `memory` | RSS, kernel memory, swap; OOM behavior | `memory.max`, `memory.high`, `memory.swap.max` |
| `io` | Block I/O bandwidth, IOPS | `io.max`, `io.weight` |
| `pids` | Number of tasks | `pids.max` |
| `cpuset` | Which CPUs and NUMA nodes the group may use | `cpuset.cpus`, `cpuset.mems` |
| `hugetlb` | HugeTLB page count | `hugetlb.<size>.max` |
| `rdma` | RDMA resource limits | `rdma.max` |

Each cgroup is a directory in `/sys/fs/cgroup/`; controllers are files in the directory. A process joins a cgroup by writing its PID to `cgroup.procs`. A container's processes all end up in a per-container cgroup tree.

**cgroups are the *enforcement* layer that namespaces lack.** A namespace tells a process "you can't see this"; a cgroup tells the *kernel* "this process can't use more than this much of that". The two compose: containers get a private *view* (namespaces) and bounded *resources* (cgroups). Neither alone is sufficient.

cgroups also provide accounting — `memory.current`, `cpu.stat`, `io.stat` give per-cgroup metrics, used by `docker stats` and by monitoring systems.

### seccomp — *which syscalls the container may issue*

Code in `kernel/seccomp.c`, BPF filter machinery in `kernel/bpf/`. `seccomp` (secure computing mode) filters syscalls per process via a small BPF program. Docker's default seccomp profile (`moby/profiles/seccomp/default.json`) blocks ~50 syscalls including:

- Kernel-module manipulation (`init_module`, `delete_module`, `finit_module`)
- Reboot/halt (`reboot`, `kexec_load`)
- Tracing/debugging (most of `ptrace`, `process_vm_readv`)
- Time setting (`settimeofday`, `clock_settime`)
- Old/dangerous syscalls (`add_key`, `keyctl`)
- Namespace creation from inside containers (`unshare`, `setns` with most flags)

A seccomp filter is a BPF program attached to the task; on every syscall, the kernel runs the filter against the syscall number and arguments; the filter returns `SECCOMP_RET_ALLOW`, `SECCOMP_RET_KILL_PROCESS`, `SECCOMP_RET_ERRNO`, or `SECCOMP_RET_USER_NOTIF`. Docker's profile is a layered allow/deny that runs on top of the always-on capability check.

Seccomp is what most narrows the container's attack surface against the kernel. Without seccomp, a compromised process could exploit *any* of the ~330 Linux syscalls; with the default profile, the attack surface shrinks to ~280.

### Capabilities — *which privileges the container retains when running as root*

Code in `kernel/capability.c`, `security/commoncap.c`. Linux **capabilities** split traditional Unix root privilege into ~40 distinct bits (`CAP_NET_ADMIN`, `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_CHOWN`, `CAP_NET_BIND_SERVICE`, …). A process's effective/permitted/inheritable/bounding capability sets are stored in `task_struct.cred`.

Docker's default capability set for a container drops 28 of the 40 capabilities at start. The retained set lets typical workloads function (`CAP_NET_BIND_SERVICE` for low ports, `CAP_CHOWN` for ownership changes, etc.) while blocking dangerous ones (`CAP_SYS_ADMIN`, `CAP_SYS_MODULE`, `CAP_NET_ADMIN`, `CAP_SYS_PTRACE`).

`--cap-add` and `--cap-drop` adjust this. Privileged containers (`--privileged`) skip the drop entirely *and* relax seccomp + AppArmor, which is why privileged containers are roughly as dangerous as host root.

### LSM (SELinux, AppArmor) — *which kernel objects the container may access*

The Linux Security Module framework lets a policy module mediate access to kernel objects (files, sockets, capabilities). Two production policies:

- **SELinux** — label-based mandatory access control. Each container gets a unique SELinux label; the policy says which labels can access which file contexts. Used by Red Hat / Fedora.
- **AppArmor** — pathname-based MAC. Each container gets a profile (Docker ships `docker-default`) describing allowed paths/operations. Used by Ubuntu / Debian.

LSM is an extra layer over namespace/capability/seccomp. It catches cases the other layers miss — e.g., a container with `CAP_DAC_OVERRIDE` could in principle read host files mounted into its namespace; AppArmor can deny by path even when capabilities allow.

### How the five compose

Container start, in essence: `clone()` with the relevant `CLONE_NEW*` flags → `pivot_root` into the image's rootfs → write the container PID into its cgroup → install seccomp filter → drop capabilities → set AppArmor/SELinux label → `execve` the container's entry point.

Five independent kernel features composing into one product. The composability didn't come for free — it took ~10 years of kernel work to make every primitive opt-in and orthogonal — but the result is that *layered, independently designed* isolation primitives can build up to a usable isolation product without a monolithic isolation framework.

---

## runc — the runtime

runc is the **OCI runtime reference implementation** — a small Go binary (~30 KLoC including vendored libcontainer) whose job is to take an *OCI runtime bundle* (a directory with a rootfs and a `config.json`) and start a container from it. runc is what every higher layer ultimately calls.

### The OCI runtime spec

The contract between runc and its callers. A runtime bundle is a directory:

```
my-container/
├── config.json         # OCI runtime spec — what to run, how to isolate
└── rootfs/             # the filesystem the container sees as /
    ├── bin/
    ├── etc/
    └── ...
```

`config.json` (`opencontainers/runtime-spec`) describes:

- `process.args`, `process.env`, `process.user` — what to run
- `process.capabilities` — capability sets
- `process.rlimits` — `setrlimit` values
- `linux.namespaces` — which namespaces to create or join
- `linux.uidMappings` / `gidMappings` — user namespace map
- `linux.resources` — cgroup limits (CPU, memory, IO, pids)
- `linux.seccomp` — the syscall filter
- `linux.maskedPaths` / `readonlyPaths` — paths to mask or remount RO
- `mounts` — additional mounts inside the container's mount namespace
- `hooks` — prestart/poststart/poststop hooks

This is the *complete* configuration; nothing about the container needs to be communicated outside the file. The spec is what made the ecosystem composable — containerd, CRI-O, podman, Kata Containers all generate `config.json` and invoke `runc create` (or equivalent).

### Lifecycle commands

```
runc create <id>        — set up namespaces, cgroups, etc.; spawn init but don't start
runc start  <id>        — tell init to execve the container's entry
runc exec   <id> <cmd>  — setns() into a running container, run another process
runc kill   <id> <sig>  — send a signal
runc delete <id>        — clean up state
runc state  <id>        — report state for monitoring
```

The split between `create` and `start` exists so that containerd / Docker can attach to the container's stdio and inspect state before the workload actually runs.

### Container creation, step by step

In `libcontainer/container_linux.go::Start` and `libcontainer/standard_init_linux.go`. Paraphrased:

```
1. Parse config.json into *configs.Config
2. Allocate cgroup directories under /sys/fs/cgroup/<container-id>/ and
   write the resource limits from config.linux.resources
3. clone() the init process with all requested CLONE_NEW* flags
4. In parent: write child PID into cgroup.procs
5. In child (init process):
   a. If user namespace requested: read uid_map/gid_map written by parent
   b. setns() into any pre-existing namespaces caller wanted to join
   c. Set up mount namespace:
      - chroot/pivot_root into the rootfs
      - Mount /proc, /sys, /dev/pts, /dev/shm with proper flags
      - Apply config.mounts (volumes, bind mounts)
      - Remount the rootfs read-only if requested
      - Apply maskedPaths (bind-mount over with /dev/null)
      - Apply readonlyPaths (remount RO)
   d. Set hostname (UTS namespace)
   e. Drop capabilities to the configured bounding set
   f. Apply rlimits
   g. Set the AppArmor/SELinux label
   h. Install seccomp filter (must be last — affects what setup can do)
   i. Signal parent "ready"
6. Parent returns; container in "created" state
7. On runc start: parent signals init to execve(config.process.args)
8. Container is now running its workload
```

The order is load-bearing. Seccomp must come last because installing it restricts what later setup syscalls can do. Capabilities must be dropped after setup that needs them. The mount setup must happen in a fresh mount namespace so the host's mounts aren't affected.

### libcontainer and the nsenter trick

`runc/libcontainer/` is a Go library any Go OCI runtime can vendor. It hides the low-level dance:

- `factory_linux.go` — Factory tied to a state directory
- `container_linux.go` — Container objects and state machine
- `process_linux.go` — process management (init + exec processes)
- `nsenter/` — a C package compiled into the Go binary handling early namespace entry
- `cgroups/` — cgroup management (v1 and v2)
- `seccomp/`, `capabilities/`, `apparmor/`, `selinux/` — security setup

The `nsenter` C helper is worth flagging — it's the workaround for the tension between Go's goroutine/thread model and Linux's per-thread namespace state. The Go runtime can spawn arbitrary OS threads at any time; `setns(CLONE_NEWPID)` only affects child processes, not the calling thread, so the dance has to happen *before* Go's runtime starts. Hence the C constructor (`__attribute__((constructor))`) that runs before `main()`.

### Stateless and one-shot

runc keeps per-container state in `/run/runc/<id>/state.json`. This is how `runc state <id>` works without any daemon — state is on disk. The `runc list` command just reads the runtime root directory.

**runc is deliberately stateless and one-shot.** It doesn't run as a daemon. Each command spawns runc, does the work, exits. The container's init process runs independently; runc's only persistence is the state file. This composes cleanly with higher layers that want their own lifecycle management.

---

## containerd — the orchestrator

containerd (`containerd/containerd`) sits between Docker Engine (or Kubernetes) and runc. It's a daemon (~150 KLoC Go) providing:

- A gRPC API for container lifecycle
- Image distribution: pull from registries, store locally, mount as snapshots
- Snapshot management: layer composition, OverlayFS coordination
- Network plumbing (via CNI plugins, optional)
- Metrics, events, and a CRI plugin (so it can serve Kubernetes directly)

containerd's job is to make runc's one-shot statelessness practical for long-running workloads.

### Shim per container

The crucial design choice: **containerd does not stay attached to running containers**. When containerd starts a container, it spawns runc via a **shim** — a small Go binary that:

1. Calls runc to create + start the container
2. Becomes the container's parent (the container's init is a child of the shim, not of containerd)
3. Handles the container's stdio
4. Reaps the container when it exits
5. Reports state back to containerd via Unix socket

This means **containerd can be restarted without killing running containers**. Each shim is independent; if containerd dies, shims keep running; when containerd restarts, it reconnects to the existing shims. This is the "upgrade containerd without downtime" property the Docker daemon eventually grew, by way of factoring shim-out.

Code: `containerd/runtime/v2/shim/` for the shim machinery, `containerd/runtime/v2/runc/` for the runc-specific shim.

### Content store and snapshotter

Image storage is split:

- **Content store** (`containerd/content/`): content-addressed blob storage. Every blob named by SHA-256 digest. Pulled layers, manifests, configs all live here, deduplicated across images that share layers.
- **Snapshotter** (`containerd/snapshots/`): turns content-addressed layers into mountable filesystems. Default is OverlayFS-based (`snapshots/overlay/`); alternatives include `btrfs`, `zfs`, `devmapper`, `native`.

When a container is created, containerd asks the snapshotter to prepare a new mutable snapshot stacked on the image's read-only layers. The snapshotter returns mount specs (e.g., `overlay` with lower/upper/work dirs); containerd writes those into the OCI bundle's `config.json` as mounts. runc then performs the mounts inside the new mount namespace.

### CRI plugin

containerd implements Kubernetes' CRI (Container Runtime Interface) as a built-in plugin (`containerd/pkg/cri/`). This is why modern Kubernetes runs on containerd *directly*, with no Docker daemon in the picture. Kubernetes' kubelet talks gRPC to containerd's CRI endpoint; containerd spawns runc shims. The Docker Engine → containerd lineage is now an *origin story*, not a runtime dependency.

---

## dockerd — the daemon

`dockerd` (Docker Engine, `moby/moby`) is the user-facing daemon (~600 KLoC Go counting vendored libraries). It provides:

- The Docker REST API (`/var/run/docker.sock`) that `docker` CLI talks to
- High-level concepts the OCI spec doesn't have: networks, volumes, services, builds
- Image building (`docker build` runs a Dockerfile, producing layered images)
- Plugin management (volume plugins, network plugins)
- BuildKit integration for modern image builds

`dockerd` is a containerd *client*. It receives `docker run` requests, builds the OCI spec, calls containerd's gRPC API, which calls a runc shim, which calls runc, which configures kernel-feature flags. Each layer adds vocabulary the next layer up uses; the layer below doesn't know it exists.

This is the layer most users actually interact with, but architecturally it's the thinnest — most of `moby/`'s line count is image management, networking abstraction, and build automation, not container runtime.

---

## End-to-end: `docker run nginx`

The single most useful explanatory device. Watch the stack actually work:

```
$ docker run -p 8080:80 nginx
   │
   ▼ HTTP POST /containers/create + /start (via /var/run/docker.sock)
dockerd (moby)
   │ 1. resolve "nginx" → registry image reference
   │ 2. ensure image present locally (pull from registry if not)
   │    └─ pulls manifest + layer blobs into containerd's content store
   │ 3. set up Docker-level concepts: network (default bridge), port-mapping
   │    └─ adds iptables DNAT rule: host:8080 → container:80
   │ 4. build OCI spec from image config + CLI options + dockerd defaults
   │    └─ resulting config.json carries: process.args=["nginx", "-g", "daemon off;"],
   │       linux.namespaces=[mount,pid,net,ipc,uts], cgroup limits, seccomp profile,
   │       mounts (volumes, /etc/resolv.conf, /etc/hostname, …)
   │ 5. gRPC: CreateContainer → containerd
   ▼
containerd
   │ 6. snapshotter.Prepare(image layers + new upper)
   │    └─ allocates upper/work dirs; returns OverlayFS mount spec
   │ 7. write OCI bundle to disk: rootfs mount-points + config.json
   │ 8. spawn containerd-shim-runc-v2 (the per-container shim)
   ▼
containerd-shim-runc-v2
   │ 9. fork/exec runc create <id>
   ▼
runc create
   │ 10. parse config.json
   │ 11. allocate cgroup dirs under /sys/fs/cgroup/<id>/; write limits
   │ 12. clone() init with CLONE_NEWNS|NEWPID|NEWNET|NEWIPC|NEWUTS
   │ 13. parent writes child PID into cgroup.procs
   │ 14. in child (init):
   │     - setns into any joined namespaces
   │     - mount overlay rootfs; mount /proc, /sys, /dev/pts
   │     - apply config.mounts
   │     - set hostname
   │     - drop capabilities to bounding set
   │     - set AppArmor label
   │     - install seccomp filter
   │     - signal parent "ready"; sleep on a pipe waiting for "go"
   │ 15. runc exits; container is in "created" state
   ▼ (control back to shim, then containerd, then dockerd)

dockerd: StartContainer → containerd → shim → runc start
   ▼
runc start
   │ 16. signal init to execve(["nginx", "-g", "daemon off;"])
   ▼
init in container
   │ 17. exec replaces init's image with nginx
   │ 18. nginx runs — sees container's view of /, listens on :80
   │ 19. when packets arrive at host:8080, iptables DNAT routes them
   │     through the veth pair into the container's netns, into nginx
   ▼
nginx serves the request

(Meanwhile: the shim stays attached, handles nginx's stdio, will reap nginx
when it exits, reports state to containerd. dockerd is free; containerd is
free; the running container does not depend on either being alive.)
```

The whole sequence: ~700 KLoC of Go across the stack to do what amounts to ~30 syscalls. The complexity is in the *control plane* — orchestration, image distribution, networking, build automation — not the isolation mechanism. The mechanism is small; the user-facing product is large.

---

## Images and distribution

Half of Docker's actual value proposition is *images* — content-addressed, layered, distributable filesystem bundles. Architecturally independent from the runtime story, but architecturally so important to Docker's identity that it warrants treatment.

### OCI image spec

An image is a **manifest** referring to a set of **layers** and a **config**, all stored as content-addressed blobs:

```
manifest (sha256:abc...)
├── config: sha256:def...   ← JSON: env, cmd, entrypoint, working dir, …
└── layers:
    ├── sha256:111...       ← tarball: full filesystem at layer 1
    ├── sha256:222...       ← tarball: diff from layer 1 → layer 2
    ├── sha256:333...       ← tarball: diff from layer 2 → layer 3
    └── sha256:444...       ← tarball: diff from layer 3 → layer 4 (top)
```

Each layer is a tarball containing files added/modified, plus *whiteout files* (`.wh.foo`) marking files deleted relative to the parent. Blobs are content-addressed by SHA-256, so two images sharing a base layer share that layer's storage automatically.

The **registry protocol** (Docker Registry v2, OCI Distribution Spec) is HTTP — pull is `GET /v2/<image>/manifests/<tag>` followed by `GET /v2/<image>/blobs/<digest>` for each layer. Push is the reverse. Authentication via bearer tokens.

### Why content addressing matters

Three properties fall out:

1. **Deduplication.** Two images using `FROM ubuntu:24.04` share that layer's storage. The host pulls it once.
2. **Cacheable builds.** `docker build` checks if a build step's inputs match a previously cached layer; if so, reuses. This is what makes incremental builds fast.
3. **Verifiable distribution.** A manifest digest uniquely identifies an image; pulling by digest (`docker pull nginx@sha256:abc...`) guarantees you got the exact bytes the publisher built, regardless of what `latest` happens to point at now. The basis of supply-chain security tools like Sigstore.

### OverlayFS — making layers mountable

Code in `fs/overlayfs/`. OverlayFS is a Linux union filesystem presenting a stack of read-only **lower** directories with a read-write **upper** directory layered on top, unified into a single mount point:

```
                 ┌──────────────────────────────────┐
                 │   merged view (the container's   │
                 │   rootfs):                       │
                 │     /usr/bin/python  ← lower2    │
                 │     /etc/hostname    ← upper     │
                 │     /tmp/cache       ← upper     │
                 └──────────────────────────────────┘
                              ▲
                  ┌───────────┼───────────┐
                  │ upper (rw)│           │ work (overlay scratch)
            ┌─────┴─────┐     │     ┌─────┴─────┐
            │           │     │     │           │
        ┌───┴─────┐     │     │     │           │
        │ lower2  │ ← image layer 2 │           │
        │ lower1  │ ← image layer 1 │           │
        │ base    │ ← image layer 0 │           │
        └─────────┘                 │           │
```

A container's rootfs is mounted as `overlay` with `lowerdir=<image layers>,upperdir=<container-private writes>,workdir=<scratch>`. Reads check upper first, then walk lower layers in order. Writes go to upper, with copy-up: if a file exists only in lower and is written, the kernel copies it to upper first, then writes there. Deletes are handled by whiteout entries in upper.

**OverlayFS is what makes container start fast.** No file copying happens to create a container — just an `overlay` mount with the image's layers as `lowerdir`. Container deletion is just `umount` + delete the upper directory. The image's layers are immutable and shared by all containers using them.

This is the analog of *copy-on-write VM disks* (qcow2 backing files), realized at the filesystem level rather than the block-device level. The architectural lesson — **content-addressed immutable layers with copy-on-write composition** — is broadly applicable; it's the same idea git uses for objects and Nix uses for packages.

### Build pipeline

`docker build` reads a Dockerfile and runs each instruction:

```dockerfile
FROM ubuntu:24.04           # base layer (pull if not cached)
RUN apt-get update          # commit a new layer with the diff
RUN apt-get install nginx   # commit another layer
COPY ./nginx.conf /etc/     # commit another
CMD ["nginx", "-g", "daemon off;"]
```

Each instruction produces a new layer. The builder caches per instruction by hashing inputs (command + base image digest + COPY/ADD sources); if the hash matches a cached layer, reuse it. This is why Dockerfile order matters for cache efficiency: put slowest-changing instructions first.

Modern Docker uses **BuildKit** (`moby/buildkit`) — a redesigned builder with parallel layer construction, mount-cache support, secrets handling, multi-arch builds via `binfmt_misc` + `qemu-user-static`. This last is where QEMU user-mode and Docker meet: `docker buildx build --platform=linux/arm64` on x86 routes ARM-arch `RUN` commands through `qemu-aarch64-static`.

---

## Networking and storage

### Networking

Container networking is mostly **veth + bridge + iptables**:

- A **veth pair** is a Linux virtual interface kind: two interfaces connected as if by a cable. One end goes inside the container's netns; the other stays in the host's.
- The host-side veth is attached to a **bridge** (typically `docker0`).
- **iptables NAT** rules translate between container IPs (on the bridge subnet) and the host's external IP.
- **DNS** is provided by an embedded resolver in the container.

Default ("bridge mode"). Other modes:

- `host` — container shares the host's network namespace; no isolation, full performance.
- `none` — container has only `lo`; user provides networking.
- `overlay` — multi-host networking using VXLAN encapsulation; used by Swarm and (with CNI) k8s.
- `macvlan` / `ipvlan` — container gets its own MAC/IP on the physical network, no NAT.

The networking layer is plug-in via **CNI** (Container Network Interface). Each plugin is a small binary called by containerd with namespace path + config; the plugin does the setup. Calico, Cilium, Flannel are CNI plugins.

### Storage

Beyond the OverlayFS rootfs, containers can mount:

- **Volumes** (`-v name:/path`): host-managed named storage, persistent across container lifetime. Stored under `/var/lib/docker/volumes/`.
- **Bind mounts** (`-v /host/path:/container/path`): direct mount of a host path into the container. Useful for development, dangerous for production.
- **tmpfs** (`--tmpfs /path`): in-memory filesystem inside the container.

Bind mounts are worth flagging: they pierce the mount namespace's isolation by design. A bind-mounted `/var/run/docker.sock` lets a container *control the Docker daemon* — equivalent to root on the host. This is a routine gotcha.

---

## Performance

Docker has essentially **zero virtualization overhead** in steady state. A container's CPU instructions run native on the host; memory accesses go through host page tables; syscalls hit the host kernel directly. There's no VMM mediating.

The measurable overheads are at the edges:

| Source | Overhead |
|---|---|
| Container startup | Tens to hundreds of ms (clone + mount + setup), vs. tens of ms for `fork+exec` |
| Network (bridge mode) | A few % from veth + bridge + iptables; near zero in `host` mode |
| OverlayFS reads/writes | A few % vs. native filesystem; first-write copy-up is more expensive |
| Per-syscall seccomp filter | ~50 ns of BPF eval per syscall |
| Per-syscall LSM check | Comparable to seccomp |
| Memory accounting (cgroup v2) | A few ns per page fault |

By comparison: KVM imposes ~5–10% overhead on CPU-heavy workloads and 10–30% on I/O-heavy workloads even with virtio + vhost. Docker imposes <2% on both. This is the central reason containers won the dense-deployment market — at scale, the per-VM overhead of KVM-based cloud sums to significant CPU and memory waste, while containers add essentially nothing per workload.

The trade-off is isolation strength.

---

## Where Docker sits in the isolation-mechanism design space

The point of this note for the survey: Docker is one point on the [§02](/virtualization/taxonomy/) isolation-boundary axis, and reading it next to the hypervisor notes makes the axis legible. The complete picture across systems studied:

| System | Isolation mechanism | TCB | Per-call cost | Performance ceiling |
|---|---|---|---|---|
| Xen (Type-1, disaggregated) | Hardware: per-domain PT + ring deprivileging or VMX non-root | Hypervisor + dom0 kernel | Hypercall: ~hundreds of cycles; VM-exit: ~thousand | Near-native with PVH/EPT |
| KVM (Type-2) | Hardware: per-VM EPT + VMX non-root | Linux kernel + KVM module + userspace VMM | VM-exit: ~thousand cycles | Near-native with virtio + vhost |
| hvisor (Type-1, separation kernel) | Hardware: static partitioning + Stage-2 PT | Small Rust hypervisor + zone0 Linux | Hypercall: hundreds of cycles | Near-native (no scheduling cost) |
| **Docker (OS-level)** | **Software: kernel feature flags** | **Entire Linux kernel** | **Per-syscall: ~50–100 ns of BPF + LSM** | **Native — no virtualization overhead** |
| gVisor *(future)* | Software: kernel reimplementation in Go intercepting syscalls | Sentry process + small host kernel surface | Per-syscall: ~microseconds | 10–50% slower than native |
| Astervisor (planned) | Language: Rust type system + ownership | OSTD + visor unsafe regions | Per-call: Rust function call (~ns) | Near-native, by hypothesis |

The pattern: **stronger isolation costs more per call; weaker isolation requires more shared trust.** Docker is at the "weakest isolation, smallest per-call cost" end. Hypervisors are at the "strongest isolation, larger per-call cost" end. Astervisor's hypothesis is that **language-level isolation can hit a new point on this curve** — Rust's type checks happen at compile time, so the runtime cost is near zero, while the isolation guarantees can (in principle) be as strong as hardware's.

### Why Docker isolation is weaker than VM isolation

Three concrete differences:

1. **Container escapes are kernel CVEs.** A bug in any of the ~30M lines of Linux can give a container root on the host. Famous historical examples: CVE-2016-5195 (Dirty COW), CVE-2017-1000405 (Huge Dirty COW), CVE-2019-5736 (runc-overwrite via `/proc/self/exe`), CVE-2022-0185 (filesystem context UAF). Hypervisor TCB is orders of magnitude smaller; CVEs are rarer and narrower.
2. **Shared kernel attack surface.** Containers share the kernel's syscall surface. Seccomp narrows this, but every allowed syscall is a potential bug. KVM guests have *no* shared syscall surface with the host — they exit via well-defined VMX events.
3. **Side channels via shared kernel state.** Shared schedulers, shared page cache, shared TLB. Cross-container timing attacks are possible because the kernel doesn't isolate at the microarchitectural level. Most hypervisors don't either, but the surface is smaller.

This is why production hostile-multi-tenant workloads (AWS Lambda, GCP Cloud Run) run on **microVMs** (Firecracker) rather than bare containers — they want VM-grade isolation with container-grade density and startup time. Kata Containers (future note) is the same idea: "containers" inside a microVM for the boundary, container API on top.

---

## Architecture matrix

A single-system summary, in the same shape as the matrices in [Xen](/virtualization/systems/xen/) / [KVM](/virtualization/systems/kvm/) / [QEMU](/virtualization/systems/qemu/):

| Topic | Docker |
|---|---|
| **Placement** | OS-level virtualization; no VMM in the §02 sense |
| **Guest CPU** | Host CFS schedules container threads as ordinary tasks; cgroups CPU controller caps |
| **Guest memory** | Host mm; cgroups memory controller caps RSS / swap; OOM behavior per cgroup |
| **Address space** | Host process address space; mount namespace gives a private rootfs view |
| **Hardware support** | None required |
| **CPU virtualization mechanism** | None |
| **Memory virtualization mechanism** | None (cgroups *limit*, don't *virtualize*) |
| **Device emulation** | None — host devices visible per devices cgroup + mount namespace |
| **Filesystem** | OverlayFS over content-addressed image layers + container-private upper |
| **Networking** | veth pair + bridge + iptables (default); CNI for alternatives |
| **Storage** | Volumes (host-managed), bind mounts (host path), tmpfs |
| **Syscall ABI** | Linux syscall ABI directly — no translation |
| **Image distribution** | OCI Distribution Spec over HTTP; content-addressed blobs |
| **Container lifecycle** | runc (one-shot) ← containerd shim (per-container daemon) ← containerd (orchestrator) ← dockerd (API daemon) |
| **Isolation enforcement** | namespaces + cgroups + seccomp + capabilities + LSM |
| **TCB** | Entire Linux kernel + the full stack (dockerd + containerd + runc) |
| **Startup time** | Tens to hundreds of ms |
| **Per-syscall overhead** | ~50–100 ns (seccomp BPF + LSM hooks) |
| **Steady-state CPU overhead** | <1% vs. native |
| **Memory overhead** | A few MB of cgroup accounting state per container |

One-sentence summary: **Docker is the design that gets near-native performance by sharing the host kernel, and the OCI stack is the design that lets one runtime serve every workload by standardizing the container handoff at runc.**

---

## Source map

```text
moby/                                — Docker Engine
├── daemon/                          — dockerd: API server, container lifecycle
├── api/                             — REST API definitions
├── client/                          — Docker CLI client library
├── builder/                         — image build (legacy; BuildKit is modern)
├── image/, distribution/            — image storage and registry interaction
├── network/                         — libnetwork: bridge/overlay/etc.
├── volume/                          — volume drivers
└── plugin/                          — plugin system

containerd/containerd                — container runtime orchestration daemon
├── runtime/v2/                      — shim API and runc shim
├── runtime/v2/runc/                 — runc-specific shim
├── content/                         — content-addressed blob store
├── snapshots/                       — snapshot management (overlay, btrfs, …)
├── images/                          — image store
├── pkg/cri/                         — Kubernetes CRI implementation
├── plugins/                         — pluggable subsystems
└── api/                             — gRPC service definitions

opencontainers/runc                  — OCI runtime reference implementation
├── libcontainer/                    — the engine; ~all the interesting code
│   ├── container_linux.go           — Container state machine
│   ├── standard_init_linux.go       — init process: clone, setup, exec
│   ├── factory_linux.go             — Factory pattern for Container creation
│   ├── process_linux.go             — process lifecycle inside container
│   ├── nsenter/                     — C helper for early namespace entry
│   ├── cgroups/                     — cgroup v1 and v2 management
│   ├── seccomp/                     — seccomp filter installation
│   ├── capabilities/                — capability set management
│   ├── apparmor/, selinux/          — LSM label installation
│   └── system/                      — Linux syscall wrappers
└── runc/                            — runc command-line driver

opencontainers/runtime-spec          — OCI runtime spec (JSON schema + docs)
opencontainers/image-spec            — OCI image spec
opencontainers/distribution-spec     — registry protocol

Linux kernel
├── kernel/nsproxy.c                 — nsproxy struct, namespace dispatch
├── kernel/pid_namespace.c           — PID namespace
├── net/core/net_namespace.c         — network namespace
├── fs/namespace.c                   — mount namespace
├── ipc/namespace.c                  — IPC namespace
├── kernel/utsname.c                 — UTS namespace
├── kernel/user_namespace.c          — user namespace (UID/GID mapping)
├── kernel/time_namespace.c          — time namespace
├── kernel/cgroup/                   — cgroups v1 and v2 core
├── kernel/cgroup/cgroup.c           — cgroup hierarchy management
├── kernel/sched/                    — CPU controller (cpu.c)
├── mm/memcontrol.c                  — memory controller
├── kernel/seccomp.c                 — seccomp filter machinery
├── kernel/capability.c              — capability set management
├── security/                        — LSM framework
├── security/selinux/, security/apparmor/   — LSM implementations
├── fs/overlayfs/                    — OverlayFS
└── net/netfilter/                   — iptables/nftables for container networking
```

---

## Relationship to Astervisor

Docker is at the opposite end of the isolation-boundary axis from Astervisor:

| Choice | Docker | Astervisor (planned) |
|---|---|---|
| Isolation mechanism | Kernel feature flags (software-enforced) | Rust type system (compile-time-enforced) |
| TCB size | Entire Linux kernel (~30M LoC) | OSTD + visor's unsafe regions (small) |
| Per-call cost | ~50–100 ns (BPF + LSM) | Rust function call (~ns) |
| Shared substrate | Host kernel runtime | OSTD runtime, language-checked |
| Cross-domain communication | Linux IPC (sockets, shared memory) | Typed Rust channels |
| Performance ceiling | Near-native | Near-native, by hypothesis |
| Failure mode of isolation | Kernel CVE → container escape | `unsafe` block bug → domain compromise |

### Cautionary lessons

- **Shared TCB is the price of near-native performance.** Docker's <2% overhead is bought entirely by sharing the host kernel. There is no path to "container-grade speed with hypervisor-grade isolation" using only kernel features — it's the *kernel sharing* that makes containers fast. Astervisor's language-isolation pitch is that *types* can break this trade-off: compile-time checks impose zero runtime cost, so isolation can be strong without per-call cost. Whether this pitch holds in practice is the project's central research question.
- **Every isolation mechanism leaks somewhere.** Docker's leaks are kernel CVEs (Dirty COW, runc-overwrite) and shared microarchitectural state. Astervisor's analogous leaks will be: unsafe-block bugs in `ostd/`, miscompilation of language-level guarantees, side channels through the shared OSTD scheduler/allocator. **Audit the leakage paths, not the design abstraction.**
- **The control plane grows without bound when isolation is cheap.** Docker added building, registries, networking, volumes, plugins, orchestration — because per-container cost was low enough to bundle everything per-container. KVM-style hypervisors had stronger per-VM costs and stayed more focused. Astervisor will face the same pull if per-domain cost is low: resist building a Docker-shaped feature ecosystem before the isolation story is verified.
- **Standardization (OCI) is the only reason the ecosystem composes.** Docker was a monolith; the ecosystem became plural only after the OCI spec extracted runc as a contract. Astervisor's analogous extraction — what *is* the domain ABI? — should be designed early, even if there's only one implementation, to enable future plurality.

### Positive lessons

- **The runc / containerd / dockerd split is structurally good.** runc is small, stateless, one-shot, with a clear spec contract. containerd handles long-running orchestration. dockerd handles UX. Each layer is a separate codebase the others don't dictate. **Astervisor's domain launcher should aim for a runc-sized contract** — minimal, declarative, easy to call from any orchestrator.
- **Content-addressed immutable layers compose.** OCI images, qcow2 backing files, git objects, Nix store paths all use the same idea: content-addressed blobs + composition operators. **Astervisor's image/payload format should follow this template** — content-addressed Rust artifacts that compose into domain bundles.
- **A standardized minimal runtime spec wins over many bespoke runtimes.** OCI runtime spec is small (a JSON schema + a handful of operations) and every container ecosystem implements it. The lesson for Astervisor: **define a small spec for "start a domain" early, even before the implementation is mature**, so future runtimes can be plural.
- **Per-feature kernel flags compose surprisingly well.** Namespaces, cgroups, seccomp, LSM are independent mechanisms developed at different times; composing them gives Docker. The lesson: **isolation mechanisms should be composable along axes, not bundled into a "container" abstraction** that hides them. The user should be able to opt in/out of each (`--cap-drop ALL`, `--security-opt no-new-privileges`, custom seccomp).

---

## What this teaches that hypervisor notes don't

- **What "near-native performance" actually requires**: kernel sharing. Every system in this directory that achieves near-native performance does so by sharing more with the host. Docker shares the most; Astervisor's hypothesis is that *language* sharing can substitute for *kernel* sharing.
- **What a 30M LoC TCB looks like in practice**: routine kernel CVEs translate to container escapes. The TCB-size argument the survey makes is not theoretical — it has a real CVE history measurable in numbers.
- **What "standardized contract enables ecosystem" looks like**: OCI's runtime spec is a few-page JSON schema; from it, an industry of orchestrators (containerd, CRI-O, podman, Kata, gVisor) all interoperate. Hypervisor ecosystems don't have an equivalent — there's no "OCI for hypervisors" — and the cost is visible (every cloud has its own VMM stack).
- **What "isolation by composing kernel features" looks like at scale**: namespaces + cgroups + seccomp + capabilities + LSM, each independently designed, composing into a useful product. The composability didn't come for free — it took ~10 years of kernel work — but it shows that *layered, opt-in* isolation primitives can build up to a usable isolation product without a monolithic isolation framework.

These are the lessons specific to OS-level virtualization. KVM and Xen teach you what hardware-based isolation looks like; Docker teaches you what kernel-feature-based isolation looks like. Astervisor will need both lenses, plus a third (language-based), to position itself in the design space.
