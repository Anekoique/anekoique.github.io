---
date: '2026-06-27T13:00:00+08:00'
draft: false
title: 'Virtualization Systems — Kata Containers'
slug: 'kata'
tags: ["Virtualization", "Hypervisor", "Systems", "Containers", "microVM", "Kata"]
series: ["Virtualization Series"]
summary: "The container-VM hybrid: an OCI runtime placing each container or Kubernetes pod inside a microVM (QEMU / Firecracker / cloud-hypervisor / Dragonball) running a real Linux kernel. Hardware-grade isolation with container UX; substrate for Confidential Containers."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

Kata Containers is the **container-VM hybrid**: an OCI-compliant container runtime that runs each container inside its own dedicated microVM, giving hardware-grade isolation while preserving container UX. It was founded in 2017 from the merger of Intel's **Clear Containers** and Hyper.sh's **runV** under the OpenStack Foundation. The project is hosted at `github.com/kata-containers`, with the runtime in Go and the in-guest agent in Rust (~50 KLoC Go + ~30 KLoC Rust core, plus per-VMM integration code). Production users include Alibaba Cloud (Sandboxed Container product), Ant Financial, and the upstream Confidential Containers (CoCo) project.

What makes Kata worth reading in this survey — and what makes it the natural pair to [gVisor](/virtualization/systems/gvisor/) — is that it answers the same question *"how to get container UX with stronger isolation than Docker?"* by going in the **opposite direction** from gVisor: instead of reimplementing the kernel in userspace, Kata uses the *real* Linux kernel, but puts each container inside its own VM. The container application sees a normal Linux kernel because it's running on one; the kernel just isn't shared with other containers, and isn't even the host's kernel.

This note follows the restructured shape introduced in [Docker](/virtualization/systems/docker/) — the system's actual architecture rather than the §04–§08 hypervisor template. Kata is mostly an orchestration system that composes existing pieces (microVMs, OCI spec, runc, virtio-fs), so the structure below walks those pieces in dependency order. Source citations name canonical paths in `kata-containers/kata-containers` (`src/runtime/`, `src/agent/`, `src/dragonball/`). No pinned commit; paths are stable across recent releases.

## §02 — Taxonomy: Kata at a glance

| Axis | Kata Containers |
|---|---|
| Placement | **Container runtime running guests in per-container microVMs** — sits between Docker/Kubernetes (orchestrator) and a hypervisor (which actually runs the guest); not itself a hypervisor |
| Guest interface | **Full virtualization with a guest Linux kernel** — the container application runs unmodified on a real Linux kernel; the hardware interface is virtio-mostly |
| Hardware support | **Required**: VT-x / AMD-V / ARM virt extensions. (Some VMM backends — like cloud-hypervisor — additionally use IOMMU, EPT, etc.) |
| Isolation boundary | **Hardware** (per-VM EPT + VMX non-root mode) at the container boundary; **shared kernel** within a single Kata sandbox (where multiple containers in one pod share the guest kernel) |

The defining structural choice is **one VM per workload boundary**. In a Kubernetes pod with multiple containers, all containers in one pod share a single Kata microVM (and therefore a single guest kernel); containers in different pods get separate VMs (and separate guest kernels). The isolation granularity matches the Kubernetes pod boundary, which is the relevant unit of trust.

Three rules to internalize:

1. **Kata is not a hypervisor; it's an OCI shim that drives a hypervisor.** The hypervisor (QEMU, Firecracker, cloud-hypervisor, Dragonball) does the actual VM work. Kata's contribution is the *integration*: making "start a microVM and run a container in it" look identical to "run a container" from Docker/Kubernetes's perspective.
2. **The kernel inside the VM is a real, full Linux kernel.** This is what distinguishes Kata from gVisor: gVisor reimplements the kernel ABI in userspace; Kata runs the real thing. Compatibility is therefore total; performance overhead comes from the VM-exit cost on syscalls and on I/O virtualization.
3. **The VMM choice is a swappable backend.** Kata supports multiple hypervisors via a `Hypervisor` interface. The choice trades off startup time, compatibility, feature set, and memory footprint. Different deployments pick different backends.

## The stack

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Kubernetes / containerd / Docker (orchestrator)                 │
   │  invoking Kata via OCI runtime: --runtime=kata                   │
   └────────────────────────────────────┬─────────────────────────────┘
                                        │ OCI runtime spec (config.json)
                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  containerd-shim-kata-v2 (kata-runtime)                          │
   │  - implements containerd shim API + OCI runtime spec             │
   │  - translates OCI requests into Hypervisor + Agent calls         │
   │  - manages VM lifecycle: create / start / exec / stop / delete   │
   │  - speaks ttRPC to kata-agent over vsock                         │
   └────────────────┬────────────────────────────┬────────────────────┘
                    │                            │
                    ▼                            ▼
   ┌─────────────────────────────────┐   ┌──────────────────────────────┐
   │  Hypervisor (one of):           │   │  virtio-fs daemon            │
   │  - QEMU                         │   │  - serves container rootfs   │
   │  - Firecracker                  │   │    + bind mounts to the VM   │
   │  - cloud-hypervisor             │   │  - runs on host as user proc │
   │  - Dragonball (in-process)      │   └──────────────┬───────────────┘
   └────────────────┬────────────────┘                  │
                    │                                   │
                    ▼  starts microVM                   ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  Guest VM                                                         │
   │  ┌──────────────────────────────────────────────────────────────┐ │
   │  │  Guest Linux kernel (minimal config, virtio drivers)         │ │
   │  └────────────────────────────┬─────────────────────────────────┘ │
   │  ┌────────────────────────────▼─────────────────────────────────┐ │
   │  │  kata-agent (PID 1, Rust)                                    │ │
   │  │  - serves ttRPC on vsock                                     │ │
   │  │  - receives container spec from kata-runtime                 │ │
   │  │  - sets up cgroups inside the VM                             │ │
   │  │  - invokes runc to create the container                      │ │
   │  └────────────────────────────┬─────────────────────────────────┘ │
   │  ┌────────────────────────────▼─────────────────────────────────┐ │
   │  │  runc — exactly the same runc Docker uses                    │ │
   │  │  - applies namespaces, cgroups, seccomp inside the VM        │ │
   │  └────────────────────────────┬─────────────────────────────────┘ │
   │  ┌────────────────────────────▼─────────────────────────────────┐ │
   │  │  container processes (the actual application)                │ │
   │  └──────────────────────────────────────────────────────────────┘ │
   └───────────────────────────────────────────────────────────────────┘
```

What each layer owns:

| Layer | Code | Responsibility |
|---|---|---|
| containerd-shim-kata-v2 | `src/runtime/` (Go) | OCI runtime; VM lifecycle; ttRPC to agent; stdio forwarding |
| Hypervisor abstraction | `src/runtime/virtcontainers/hypervisor*.go` (Go) | Wraps each VMM backend behind a common interface |
| Hypervisor (concrete) | QEMU, Firecracker, cloud-hypervisor, Dragonball | Boots the microVM, virtio devices, vCPU run loop |
| kata-agent | `src/agent/` (Rust) | PID 1 in the guest; spawns containers; forwards I/O |
| runc (in guest) | `opencontainers/runc` | Same runc as Docker — applies namespaces/cgroups/seccomp inside the guest |

The clean separation matters: Kata's contribution is glue. The actual VM work is in the hypervisor backends; the actual container work is in runc; the actual container image is OCI-standard. Kata composes these into a hybrid product.

## kata-runtime — the OCI shim

`src/runtime/` is a Go implementation of the containerd-shim-v2 API and the OCI runtime spec. Same OCI surface as runc and runsc — `create`, `start`, `exec`, `kill`, `delete`, `state`, plus the long-running shim model where the shim stays alive for the container's lifetime.

Key responsibilities:

- **VM lifecycle**: instantiate a Hypervisor, configure it (CPU count, RAM, vsock, virtio-fs, virtio-net), boot the guest kernel + initrd, wait for the kata-agent to come online.
- **Container lifecycle**: translate OCI `create`/`start` requests into ttRPC calls to the agent.
- **Stdio forwarding**: container stdio is multiplexed over vsock to the shim, which exposes it to containerd as a UNIX pipe.
- **Process management**: `kata exec` opens a new ttRPC stream to the agent; the agent spawns the exec'd process inside the existing container in the VM.
- **State persistence**: each Kata sandbox has a `/run/kata-containers/<sandbox-id>/` directory with VM config, agent socket location, state.

The shim is what containerd interacts with. Containerd doesn't know it's talking to a VM — from containerd's perspective, Kata looks like any other container runtime. That OCI compliance is *the* feature that makes Kata operationally interchangeable with runc.

### Sandbox vs container

A subtle but important distinction in Kata:

- A **sandbox** is one microVM. It has one guest kernel, one set of virtio devices, one kata-agent.
- A **container** is a workload inside a sandbox, running as a group of processes inside namespaces/cgroups.
- A sandbox may host *multiple* containers — this is how Kubernetes pods (multiple containers, shared kernel and network namespace) map to Kata.

The first container in a sandbox triggers VM creation; subsequent containers reuse the VM. When the last container in a sandbox exits, the VM shuts down. This is the "one VM per pod" deployment model that's load-bearing for Kubernetes performance.

## kata-agent — the in-VM half

`src/agent/` is a Rust binary that runs as PID 1 inside the guest microVM. It is the in-guest counterpart to kata-runtime, with which it speaks ttRPC (gRPC-like protocol, smaller and used in container runtimes) over a vsock socket.

Why Rust? The kata-agent is small, has high security requirements (it's the trust boundary between the host shim and the guest), and benefits from memory safety. Earlier versions were in Go; the Rust rewrite (2019-2020) reduced binary size and memory footprint significantly — important when the agent must fit in a memory-constrained microVM.

Responsibilities:

| Function | What it does |
|---|---|
| ttRPC server | Receives commands from kata-runtime over vsock; serves the agent protocol |
| Container setup | Receives OCI spec from runtime; sets up cgroups, mounts, environment inside the VM |
| Spawn via runc | Calls runc (same binary Docker uses) to actually create the container inside the VM |
| Exec | Spawns additional processes inside an existing container, with stdio multiplexed back |
| Signal forwarding | Translates `kata kill` ttRPC calls to in-guest `kill()` |
| Mount management | Receives mount specs (virtio-fs shares, virtio-blk volumes); mounts them inside the guest |
| Network setup | Receives interface configs from runtime; configures veth+routes inside guest |
| Stats and metrics | Reports cgroup stats back over ttRPC |

The agent communicates with the runtime over **vsock** (`AF_VSOCK`), a host-guest socket type that bypasses the network stack. This is faster than virtio-net for the agent's control traffic and avoids polluting the guest network namespace with host-control traffic.

### runc inside the VM

A subtle architectural choice: the kata-agent doesn't reimplement container setup; it invokes **runc** (the same runc binary Docker uses) inside the guest VM. The agent prepares the OCI bundle on a virtio-fs share, then runs runc to apply namespaces/cgroups/seccomp/capabilities inside the guest.

Two consequences:

1. **Kata reuses all of runc's OCI compliance work**. Anything runc supports, Kata supports — by definition, because Kata uses runc.
2. **There are *two* layers of isolation**: the VM boundary (hardware-isolated) and the in-VM namespace boundary (kernel-isolated, same as Docker). For a single-container Kubernetes pod this is redundant; for a multi-container pod it lets each container have its own in-VM namespace state while sharing the VM with peers.

## The hypervisor abstraction — Kata's VMM-agnostic story

Kata defines a `Hypervisor` interface (`src/runtime/virtcontainers/hypervisor.go`) that each backend implements. The interface is small:

```go
type Hypervisor interface {
    CreateVM(ctx context.Context, id string, network Network, hypervisorConfig *HypervisorConfig) error
    StartVM(ctx context.Context, timeout int) error
    StopVM(ctx context.Context, waitOnly bool) error
    PauseVM(ctx context.Context) error
    ResumeVM(ctx context.Context) error
    AddDevice(ctx context.Context, devInfo interface{}, devType DeviceType) error
    HotplugAddDevice(ctx context.Context, devInfo interface{}, devType DeviceType) (interface{}, error)
    HotplugRemoveDevice(ctx context.Context, devInfo interface{}, devType DeviceType) (interface{}, error)
    GetVMConsole(ctx context.Context, sandboxID string) (string, string, error)
    Capabilities(ctx context.Context) Capabilities
    ...
}
```

Each backend (`src/runtime/virtcontainers/qemu*.go`, `firecracker*.go`, `clh*.go`, `dragonball*.go`) implements the interface against its VMM. Higher layers (sandbox lifecycle, agent communication) don't know which backend is active.

### Available backends

| Backend | Language | Source | Startup | Memory | Devices | Production |
|---|---|---|---|---|---|---|
| QEMU | C | qemu-project | 1-3 sec | ~100-200 MB | Full (virtio + emulated legacy) | Long-default; still most-compatible |
| Firecracker | Rust | AWS | ~125 ms | ~5 MB VMM | virtio-only, minimal | Best for serverless; limited features |
| cloud-hypervisor | Rust | Cloud Hypervisor project | ~200-400 ms | ~30-50 MB VMM | virtio + some PCI | Middle ground; supports migration |
| Dragonball | Rust | Alibaba (in-tree in Kata 3+) | ~150 ms | ~20 MB | virtio-only, container-tuned | Alibaba production; integrated build |

**QEMU**: covered in [QEMU](/virtualization/systems/qemu/). Most compatible because it implements ~300 devices. Slowest startup because it boots through SeaBIOS/OVMF and has heavier device-init paths. Default in early Kata; still default for workloads needing PCI passthrough, GPU, or other features Firecracker doesn't have.

**Firecracker**: covered in detail in [Firecracker](/virtualization/systems/firecracker/). AWS's microVM, designed for Lambda. ~50 KLoC of Rust. Boots a kernel via PVH direct boot (no firmware), supports virtio-net, virtio-blk, virtio-vsock, serial, and not much else. Optimal startup time and memory footprint at the cost of feature set. Best for short-lived stateless workloads — Lambda's exact use case, and Kata's serverless niche.

**cloud-hypervisor**: also Rust, originally spun off from Firecracker but with broader scope. Adds: SMP support beyond initial-vCPU limit, more virtio devices (virtio-fs, virtio-pmem, virtio-vsock), live migration, ACPI hotplug. The cost is more code (~150 KLoC) and slightly slower startup. Used when migration or hotplug matters.

**Dragonball**: Alibaba's contribution, integrated *into the Kata binary itself* as a Go-callable library (rather than a separate process). This eliminates the kata-runtime ↔ VMM IPC overhead — the VMM is in-process. Built specifically for cloud-native workloads, minimal device set, very fast startup. Available as an option in Kata 3.x.

### How the backend choice surfaces

In Kata's configuration (`/etc/kata-containers/configuration.toml`):

```toml
[hypervisor.qemu]              # or [hypervisor.firecracker], etc.
path = "/usr/bin/qemu-system-x86_64"
kernel = "/usr/share/kata-containers/vmlinuz"
image = "/usr/share/kata-containers/kata-containers.img"
default_vcpus = 1
default_memory = 2048
...
```

`/etc/kata-containers/configuration-<backend>.toml` provides the per-backend defaults; the active config can be selected via `runtime.Type` in the Kubernetes RuntimeClass or via container annotations. This lets a single Kata installation expose multiple flavors — `kata-qemu` for compatible workloads, `kata-fc` for serverless — selectable per workload.

## Networking

Kata supports several networking models, the choices reflecting the tension between performance and isolation:

| Model | How it works | Use case |
|---|---|---|
| **tcfilter** (default) | Container's veth on host bridge; `tc` filter mirrors packets to a tap device inside the VM | Default; works with any host network |
| **macvtap** | Macvtap device on host; passed into VM as virtio-net | Better performance than tcfilter, requires macvtap support |
| **virtio-net + bridge** | VM has virtio-net; host-side tap on host bridge | Direct virtio-net to host bridge |
| **VFIO passthrough** | A host NIC's VF assigned to the VM directly | Highest performance; consumes a SR-IOV VF |

In all cases the container's perspective is "I have a network interface" — the standard veth+bridge model containerd would create for any container. Kata's job is to forward that container netns's traffic *into* the guest VM so the in-VM container actually sees it.

The path from outside packet to nginx inside a Kata sandbox:

```
outside → host NIC → host iptables/NAT → docker0 bridge → container veth (host side)
   → tc mirror / macvtap / tap → virtio-net device in VM → guest kernel → guest container netns → nginx
```

This is more hops than Docker's `outside → docker0 bridge → container veth → nginx`. The performance cost shows up in throughput and latency, especially for high-PPS workloads.

## Storage

Storage is where Kata's design has matured significantly:

- **Container rootfs**: in modern Kata, served via **virtio-fs** — a Linux filesystem designed specifically for VMM-to-guest filesystem sharing. Replaces the older 9P-based sharing (which is what gVisor still uses via Gofer). virtio-fs is substantially faster than 9P, using FUSE-over-virtio with shared memory for data transfer. The container's OverlayFS rootfs (prepared by containerd's snapshotter on the host) is shared into the VM via virtio-fs and mounted at `/`.
- **Volumes**: typically virtio-fs for filesystem volumes, virtio-blk for block volumes.
- **Bind mounts**: virtio-fs.
- **Devices**: VFIO passthrough for cases where the container needs direct device access (GPU, NIC, etc.). Limited to devices the host can assign to a VM.

### virtio-fs vs 9P

This is one of Kata's distinguishing technical bets. The 9P protocol (used by both older Kata and gVisor's Gofer) involves per-syscall RPC, which limits performance. virtio-fs (developed by Red Hat, ~2019) is a Linux filesystem that uses FUSE over a virtio transport with **DAX (Direct Access)** — guest pages can be mapped directly into the host's page cache, eliminating data copies entirely on cached reads. Kata pioneered the production use of virtio-fs.

The benchmark gains are significant — for many filesystem workloads virtio-fs is within 10-20% of bare metal where 9P was within 50-70%. This matters because filesystem I/O is one of Kata's most-questioned overheads.

## End-to-end: `docker run --runtime=kata nginx`

```
$ docker run --runtime=kata -p 8080:80 nginx
   │
   ▼  Docker → containerd (gRPC), runtime handler = io.containerd.kata.v2
containerd
   │  snapshotter prepares OverlayFS rootfs (image layers + container upper) as usual
   │  generates OCI bundle (config.json + rootfs/) on host
   │  spawns containerd-shim-kata-v2 (the kata-runtime shim)
   ▼
containerd-shim-kata-v2
   │ Decide: is this the first container in its sandbox?
   │   Yes → create a new microVM (this is the typical case for `docker run`)
   │   No  → join an existing sandbox (Kubernetes pod with multiple containers)
   ▼
Hypervisor (e.g., Firecracker)
   │ 1. Start the VMM process; configure it via REST API or socket
   │ 2. Provide it with:
   │    - the kata guest kernel (vmlinuz)
   │    - the kata guest initramfs (containing kata-agent as PID 1)
   │    - vCPU count (per pod or per container), memory (per workload)
   │    - virtio devices: vsock (for agent ttRPC), virtio-fs (for rootfs share),
   │      virtio-net (for networking), virtio-blk (for volumes)
   │ 3. Start the VM
   ▼
Guest kernel boots:
   │  - Linux kernel start (~50-200 ms)
   │  - initramfs runs; kata-agent starts as PID 1
   │  - kata-agent opens its vsock listener and waits for ttRPC requests
   ▼
kata-runtime (host side):
   │ 1. Connects to kata-agent via vsock
   │ 2. CreateContainer ttRPC call with the OCI spec (translated for in-VM paths)
   │ 3. Tells agent: "mount this virtio-fs share at /run/kata-containers/sandbox/rootfs"
   ▼
kata-agent (in VM):
   │ 1. Mounts the virtio-fs rootfs share
   │ 2. Sets up the container's mount namespace using the shared rootfs
   │ 3. Invokes runc create on the in-VM OCI bundle
   ▼
runc (in VM):
   │ Standard runc flow: clone() + namespaces + cgroups + seccomp + capabilities + execve
   ▼
nginx running in the VM:
   │  - As a normal Linux process, inside namespaces, on a real Linux kernel
   │  - Listening on :80 inside the guest

Network flow for incoming request:
   external → host:8080 → host iptables NAT → docker0 → container veth (host)
     → tcfilter mirror to tap in VM → virtio-net → guest kernel → in-VM container's netns → nginx
```

Notice three things:

1. **The "container" is a regular Linux process inside the VM.** From the guest's perspective, nothing about Kata is visible — it's just a small Linux system.
2. **There's an extra kernel boot per `docker run`.** This is Kata's startup-time overhead vs Docker. For Kubernetes pods that live for hours, this is amortized; for short-lived FaaS workloads, the VMM-backend choice (Firecracker, Dragonball) is what makes Kata viable.
3. **The host kernel and guest kernel are isolated by the VMM.** The host kernel doesn't see nginx as a process; it sees the VMM process. To compromise the host from inside the container would require: escape namespace → escape VM kernel → escape VMM → escape host kernel. Hypervisor-grade isolation.

## Confidential Containers

Kata is the runtime substrate for the **Confidential Containers (CoCo)** project, which extends Kata to support hardware-encrypted VMs:

- **AMD SEV-SNP** — Secure Encrypted Virtualization with Nested Paging. Guest memory is encrypted with a per-VM key; the host kernel cannot read guest memory. Hardware attestation lets the guest verify it's running on a real SNP-capable CPU before unsealing secrets.
- **Intel TDX** — Trust Domain Extensions. Per-VM enclaves; full hardware isolation including from the host kernel.

In CoCo, kata-agent's role expands: it performs attestation against a remote key broker before the workload runs, only releasing the workload (or its decryption key) if the guest VM's measurement matches an expected value. This gives **"the cloud provider cannot read my data"** as a property, with cryptographic enforcement.

CoCo's main consumers: financial workloads, healthcare data processing, AI training on sensitive data. As of 2024-2025 it's still a niche use case but the primary modern reason new users adopt Kata over alternatives like gVisor (which has no equivalent confidential-computing story).

## Performance

Kata's performance is dominated by **per-sandbox startup cost** and **I/O virtualization overhead**:

| Workload | Native baseline | Docker | Kata (QEMU) | Kata (Firecracker) |
|---|---|---|---|---|
| CPU-bound (compute) | 1.0× | ~1.0× | ~0.97-0.99× | ~0.97-0.99× |
| Memory-bound | 1.0× | ~1.0× | ~0.97× | ~0.97× |
| Syscall-heavy (inside guest) | 1.0× | ~1.0× | ~1.0× (no VM-exit for in-guest syscalls) | ~1.0× |
| TCP throughput | 1.0× | ~0.95× | ~0.6-0.8× (depends on net model) | ~0.7-0.8× |
| Filesystem (virtio-fs DAX) | 1.0× | ~0.95× | ~0.8-0.9× | ~0.8-0.9× |
| Filesystem (9P, legacy) | 1.0× | ~0.95× | ~0.3-0.6× | ~0.3-0.6× |
| Container startup | tens of ms | ~50-100 ms | ~1-3 sec | ~150-300 ms |
| Memory overhead per pod | 0 | minimal | ~100-200 MB | ~20-50 MB |

Key insights:

- **Steady-state CPU and memory are nearly native.** Once the VM is running, the guest's syscalls are serviced by the guest kernel directly — no VM-exit per syscall (unlike gVisor). This is Kata's primary performance argument: hypervisor isolation, but only the *host* boundary is expensive; in-guest operations are free.
- **I/O has to cross the VM boundary.** Every network and filesystem operation eventually crosses virtio, which has a per-op cost. virtio-fs + DAX is fast but not free; virtio-net is even more expensive.
- **Startup is the headline cost.** Booting a kernel takes time. Firecracker/Dragonball get this to ~150-300 ms; QEMU is multiple seconds. For workloads where startup matters (FaaS), backend choice is critical.
- **Memory is the headline density cost.** Each pod has its own kernel (~10-30 MB) and agent (~5 MB) plus some VMM overhead. ~50-100 MB per pod overhead is real, vs ~few MB for Docker.

## Where Kata sits in the isolation-mechanism design space

Updated comparison table including all systems studied so far in the survey:

| System | Isolation mechanism | TCB | Per-call cost | Performance ceiling |
|---|---|---|---|---|
| Xen (Type-1, disaggregated) | Hardware: per-domain PT + ring deprivileging or VMX non-root | Hypervisor + dom0 kernel | Hypercall: ~hundreds of cycles; VM-exit: ~thousand | Near-native with PVH/EPT |
| KVM (Type-2) | Hardware: per-VM EPT + VMX non-root | Linux kernel + KVM module + userspace VMM | VM-exit: ~thousand cycles | Near-native with virtio + vhost |
| hvisor (Type-1, separation kernel) | Hardware: static partitioning + Stage-2 PT | Small Rust hypervisor + zone0 Linux | Hypercall: hundreds of cycles | Near-native (no scheduling cost) |
| Docker (OS-level) | Software: kernel feature flags | Entire Linux kernel | Per-syscall: ~50–100 ns of BPF + LSM | Native — no virtualization overhead |
| gVisor (userspace kernel) | Software: Sentry reimplements Linux ABI in Go | Sentry + Gofer + restricted host kernel | Per-syscall: hundreds of ns to microseconds | 10-50% slower depending on workload |
| **Kata Containers (microVM-per-container)** | **Hardware: per-container microVM + EPT** | **Guest kernel + host kernel + VMM** | **In-guest syscall: native; host VM-exit: ~thousand cycles** | **Near-native CPU; slower I/O** |
| Astervisor (planned) | Language: Rust type system + ownership | OSTD + visor unsafe regions | Per-call: Rust function call (~ns) | Near-native, by hypothesis |

Where Kata sits: **strongest isolation in the container space**, at the cost of per-pod memory and startup time. The TCB story is mixed — the guest kernel is ~30M LoC of Linux (same scary number as Docker), but it's isolated from other containers' guest kernels, and isolated from the host kernel by the VMM boundary. A compromise of a guest kernel doesn't escalate to host or peer containers without an additional VMM-escape exploit.

## gVisor vs Kata

The same comparison section as in [gVisor](/virtualization/systems/gvisor/), for symmetry — these two systems are the natural pair and the question of which to use is the practical one production teams face:

| Axis | gVisor | Kata Containers |
|---|---|---|
| Mechanism | Reimplement Linux ABI in userspace (Go) | Run each container in a real Linux VM |
| What the guest sees | Sentry's syscall handler (Linux-compatible, with gaps) | Real Linux kernel (full compatibility) |
| What's in the TCB | Sentry (~500 KLoC Go) + small host kernel surface | Guest Linux kernel + VMM + host kernel + KVM |
| Compatibility | Subset of Linux ABI; some apps don't work | 100% Linux ABI by definition |
| Performance — CPU | ~native | ~native |
| Performance — syscalls | 10-50% slower per syscall | Native (in-guest); host syscalls require VM-exit |
| Performance — filesystem | Slow (9P via Gofer) | Faster (virtio-fs + DAX) but still VM-mediated |
| Performance — network | Slower (netstack) or native (passthrough) | Slower (virtio-net through VM) |
| Startup time | ~3× Docker | ~10× Docker (boot a kernel) |
| Memory overhead per container | ~30 MB Sentry+Gofer | ~50-100 MB guest kernel + agent (less with Firecracker/Dragonball) |
| Density (containers per host) | High | Lower (per-container kernel cost) |
| Hardware requirement | Optional (depends on platform choice) | Required (VT-x / AMD-V) |
| Maturity / production use | Google internal scale (App Engine, Cloud Run) | Alibaba, Ant Financial, AWS niche workloads |
| Confidential computing | Limited | First-class (CoCo project on Kata) |

**When to pick gVisor**: hostile multi-tenant workloads where syscall reduction matters more than full compatibility; short-lived CPU-bound workloads (FaaS); environments where ~30 MB-per-container density matters; environments where hardware virt extensions are unavailable.

**When to pick Kata**: workloads that need full Linux compatibility (custom kernel modules, advanced networking, hardware passthrough); environments where the host kernel is *itself* untrusted (Confidential Containers); workloads with longer lifetimes where startup time is amortized; workloads where hypervisor-grade isolation is the explicit requirement.

In the broader design-space view: **gVisor is software-only isolation pushed as hard as it can go** — the entire kernel surface reimplemented in safe Go. **Kata is hardware isolation retrofitted under a container UX** — every container gets a real VM, but you call it `docker run`. Astervisor's language-isolation pitch is *neither* — compile-time type-checking aims to give gVisor-like isolation without the per-syscall runtime cost, while staying lighter than Kata's per-container kernel overhead.

The deeper pattern: Docker traded isolation strength for performance and density; gVisor and Kata each trade some performance or density back to recover isolation, in opposite ways. The design space has at least three viable points — and Astervisor is staking a claim that a fourth point exists, reachable only via language-level guarantees.

## Architecture matrix

A single-system summary, in the same shape as the matrices in [Docker](/virtualization/systems/docker/) / [gVisor](/virtualization/systems/gvisor/) / [KVM](/virtualization/systems/kvm/) / [QEMU](/virtualization/systems/qemu/):

| Topic | Kata Containers |
|---|---|
| **Placement** | Container runtime running guests in per-container microVMs |
| **Guest CPU** | vCPU model from the underlying VMM (QEMU/Firecracker/etc.) |
| **Guest memory** | Backed by VMM's allocation; EPT-isolated from other VMs |
| **Address space** | Guest VM has full virtual address space; host sees just the VMM process |
| **Hardware support** | Required: VT-x / AMD-V; optionally IOMMU, SR-IOV, SEV-SNP, TDX |
| **CPU virtualization mechanism** | Per-VMM (KVM for QEMU/Firecracker/cloud-hypervisor/Dragonball) |
| **Memory virtualization mechanism** | EPT, via the VMM |
| **Device emulation** | virtio-net, virtio-fs, virtio-blk, virtio-vsock, virtio-pmem (varies by VMM) |
| **Filesystem** | virtio-fs (DAX-capable) for rootfs + shared dirs; virtio-blk for block volumes |
| **Networking** | tcfilter / macvtap / virtio-net + bridge / VFIO passthrough |
| **Storage** | virtio-fs + virtio-blk + VFIO; host snapshotter prepares OverlayFS rootfs that's shared into VM |
| **Syscall ABI** | Linux syscall ABI directly — guest is real Linux |
| **Image distribution** | OCI image spec via containerd (no Kata-specific format) |
| **Container lifecycle** | kata-runtime (containerd-shim-kata-v2) ← VMM ← kata-agent ← runc (in guest) |
| **Isolation enforcement** | Hardware (EPT + VMX non-root) at sandbox boundary; in-guest runc isolation for multi-container pods |
| **TCB** | Guest Linux kernel + VMM + host Linux kernel + kata-runtime + kata-agent |
| **Startup time** | Hundreds of ms (Firecracker / Dragonball) to seconds (QEMU) |
| **Per-syscall overhead** | Zero (in-guest syscalls hit guest kernel directly) |
| **Steady-state CPU overhead** | ~1-3% |
| **Memory overhead** | 20-200 MB per sandbox depending on VMM |

One-sentence summary: **Kata is the design that gets hypervisor-grade isolation under a container API by giving each container its own real Linux kernel inside a microVM, paying for it in startup time and per-pod memory rather than in steady-state performance.**

## Source map

```text
kata-containers/kata-containers/         — main repo
├── src/runtime/                         — Go: containerd-shim-kata-v2, OCI runtime
│   ├── cmd/                             — runtime entry points
│   ├── containerd-shim-v2/              — containerd shim implementation
│   ├── virtcontainers/                  — VMM abstraction and lifecycle
│   │   ├── hypervisor.go                — Hypervisor interface
│   │   ├── qemu*.go                     — QEMU backend
│   │   ├── firecracker*.go              — Firecracker backend
│   │   ├── clh*.go                      — cloud-hypervisor backend
│   │   ├── dragonball*.go               — Dragonball backend
│   │   ├── sandbox.go                   — Sandbox lifecycle
│   │   └── container.go                 — Container lifecycle
│   ├── pkg/agent/                       — ttRPC client to kata-agent
│   └── config/                          — configuration parsing
├── src/agent/                           — Rust: kata-agent (in-guest)
│   ├── src/main.rs                      — PID 1 entry
│   ├── src/rpc.rs                       — ttRPC server
│   ├── src/sandbox.rs                   — in-VM sandbox state
│   ├── src/mount.rs                     — virtio-fs and virtio-blk mount handling
│   └── src/namespace.rs                 — in-VM namespace setup
├── src/dragonball/                      — Rust: Dragonball VMM (in-tree)
├── tools/osbuilder/                     — guest image and kernel build tooling
├── docs/                                — design documents
└── ci/                                  — integration tests

Related projects (external):
opencontainers/runc                       — runc, invoked inside the guest
qemu-project/qemu                         — QEMU backend
firecracker-microvm/firecracker           — Firecracker backend
cloud-hypervisor/cloud-hypervisor         — cloud-hypervisor backend
gluster/virtio-fs (host) + Linux kernel   — virtio-fs daemon and guest driver

confidential-containers/                  — CoCo project: Kata-based confidential containers
├── operator/                             — Kubernetes operator
├── guest-components/                     — agent extensions for attestation
└── trustee/                              — KBS (key broker service)
```

## Relationship to Astervisor

Kata is at the opposite end of the isolation-mechanism design space from Astervisor — strongest hardware isolation, biggest per-workload kernel footprint. The lessons are mostly contrasts but with one structural feature worth copying.

| Choice | Kata | Astervisor (planned) |
|---|---|---|
| Isolation mechanism | Per-container microVM (hardware) | Compile-time Rust types (language) |
| Per-workload TCB | Whole guest Linux kernel + VMM + host | OSTD + visor unsafe regions |
| Per-workload memory | 20-200 MB (kernel + agent + VMM) | Small (Rust binary + minimal runtime) |
| Per-workload startup | Hundreds of ms to seconds | Should be near-instant (no kernel boot) |
| Compatibility | 100% Linux ABI | Cooperating Rust guests only |
| Density (workloads/host) | Limited by per-workload memory | High (no per-workload kernel) |
| Failure mode of isolation | VMM exploit → host root | Unsafe-block bug → domain compromise |
| Confidential computing story | First-class (CoCo) | TBD |

### Cautionary lessons

- **Per-workload kernel is expensive in memory.** Kata's ~50-100 MB-per-pod overhead is significant at cluster scale. Astervisor's pitch — *no kernel for the guest to have its own copy of* — is the response. If Astervisor ever needs to host workloads that *want* their own kernel (e.g., for compatibility), it inherits this memory cost.
- **Startup time is a real product constraint.** The Firecracker/Dragonball backends exist *because* QEMU is too slow to start for FaaS workloads. Astervisor's domain startup time should be measured in microseconds, not milliseconds, to compete with anything other than already-warm Kata sandboxes.
- **Hardware isolation has a hardware bug surface.** Kata depends on the correctness of VT-x, EPT, and (for CoCo) SEV-SNP/TDX. Hardware bugs (L1TF, MDS, Reptar, Downfall) have repeatedly leaked across these boundaries. Language isolation has its own surface (compiler correctness, OSTD bugs) but it's a different and bounded surface.
- **Multi-backend support is a feature *and* a maintenance burden.** Kata supports four VMMs because no single VMM fits every workload — but supporting four means abstracting over four very different APIs. Astervisor should be honest about whether it can offer one well-designed mechanism or whether it needs multiple, and pay the integration cost accordingly.

### Positive lessons

- **The OCI compatibility layer is the right place to slot in any isolation mechanism.** Kata works because it speaks OCI; containerd, Kubernetes, Docker all interoperate without modification. **Astervisor should expose its domains via an OCI-compatible runtime** even if domains aren't Linux containers in spirit, to gain ecosystem composability and ease of adoption. The OCI runtime spec is small enough to implement against any sandbox primitive.
- **The hypervisor abstraction interface is structurally good.** Kata's `Hypervisor` interface is a clean separation between policy (lifecycle, configuration) and mechanism (the actual VMM). Astervisor's vCPU/domain runtime should have a similar abstraction so that different domain-execution mechanisms (e.g., regular Rust async runtime vs OSTD-managed cooperative scheduler) can plug in.
- **The host/guest agent split with ttRPC over vsock is a clean pattern.** kata-agent's role — small Rust process speaking a typed protocol over a constrained transport — is exactly the kind of trusted-but-narrow component Astervisor needs at its domain boundaries. The choice of Rust for the agent is itself a precedent: when isolation matters, memory safety matters.
- **Reusing runc inside the guest is good engineering.** Kata didn't reimplement container setup; it called runc. This composability — *one common substrate for in-namespace container setup, multiple mechanisms for the outer isolation* — is the design pattern that lets the ecosystem accumulate value. Astervisor's domain model should aim for a similar layering: a small, reusable in-domain runtime, with the outer isolation mechanism (language types) being the new contribution.

## What this teaches that other notes don't

Kata teaches a fourth path different from any other system in the survey: **wrap container UX around a real VM**. Not a hypervisor (Kata isn't itself a hypervisor; it drives one). Not a kernel-feature container (the isolation is hardware, not kernel flags). Not a userspace kernel reimpl (the kernel inside the VM is real Linux).

The defining trade: **hypervisor-grade isolation at container-grade UX, with the cost paid in startup time and memory rather than steady-state performance**. This is a meaningfully different point in the design space — the cost shape is "fixed per-workload" rather than "per-call". For workloads with long lifetimes (Kubernetes pods running for hours), this cost shape is preferable to gVisor's per-syscall cost; for short-lived FaaS workloads, the per-pod cost dominates and Firecracker-direct (which Kata can use as a backend) wins.

The broader lesson for Astervisor: **the cost-shape of the isolation mechanism is as important as its strength**. A 5% per-call overhead is fatal for a hot path with 10^9 calls; a 100 MB-per-workload overhead is fatal for a host running 10^4 workloads. Astervisor's pitch — language-level isolation enforced at compile time — claims to have *neither* cost shape: no per-call overhead because there are no runtime checks, no per-workload overhead because there is no per-workload kernel or sandbox process. Whether this pitch holds in practice is what `redleaf.md` (future note) is going to be helpful for evaluating: it's the closest production precedent for language-isolated systems doing something like what Astervisor proposes.

Together, gVisor and Kata define the practical limits of *runtime* isolation extensions to the container model. Astervisor's claim is that *compile-time* isolation can do better. The survey will be complete enough to evaluate that claim once RedLeaf is in too.
</content>
</invoke>
