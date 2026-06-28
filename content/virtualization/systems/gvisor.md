---
date: '2026-06-27T11:00:00+08:00'
draft: false
title: 'Virtualization Systems — gVisor'
slug: 'gvisor'
tags: ["Virtualization", "Systems", "Containers", "Sandbox", "gVisor", "Go"]
series: ["Virtualization Series"]
summary: "Google's userspace-kernel sandbox: Sentry, a Go reimplementation of the Linux syscall ABI, services guest syscalls intercepted via KVM / ptrace / systrap platforms. Production isolation behind App Engine, Cloud Run, and Cloud Functions."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

gVisor is Google's **userspace-kernel sandbox**: a container runtime where most of the guest's Linux syscalls are serviced by a Go-implemented userspace kernel called **Sentry** rather than by the host Linux kernel. It was developed inside Google starting ~2015, open-sourced in 2018, and is the production sandbox behind Google App Engine, Cloud Run, and Cloud Functions — every short-lived multi-tenant workload Google runs on shared hardware is gVisor-isolated. The repository is at `google/gvisor`, ~500 KLoC of Go plus small C/asm helpers.

What makes gVisor worth reading carefully — and what makes it different from Docker — is that it answers the question *"how do you keep container UX while drastically narrowing the host-kernel attack surface?"* by **reimplementing the kernel ABI in userspace**. A gVisor-sandboxed application makes Linux syscalls exactly as if it were running on Linux; gVisor intercepts those syscalls and services them itself, only ever exposing a tiny, carefully-audited subset of host syscalls to do its own work. The host kernel sees a single sandboxed process (the Sentry) talking to a tightly-restricted set of syscalls, not the much larger surface a normal container would expose.

This note follows the restructured shape introduced in [Docker](/virtualization/systems/docker/) — gVisor's actual architecture, not the §04–§08 hypervisor template. gVisor has no virtual CPU, no virtual MMU, no virtual hardware in the [§03](/virtualization/vmm-architecture/) sense; forcing those headings produces empty sections. The structure below covers the substrate (Sentry, the platforms), the supporting helpers (Gofer, netstack), and gVisor's position in the isolation-mechanism design space. Source citations name canonical paths in the `google/gvisor` tree (`runsc/`, `pkg/sentry/`, `pkg/sentry/platform/`, `pkg/tcpip/`); no pinned commit, paths are stable across recent releases.

## §02 — Taxonomy: gVisor at a glance

| Axis               | gVisor                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement          | **Userspace sandbox** — neither a hypervisor nor a kernel-feature container. Sentry runs as a host user process; the guest application runs as another user process whose syscalls Sentry intercepts                |
| Guest interface    | **Linux syscall ABI** — guest sees a Linux kernel, but it's Sentry's *reimplementation*, not the host's. ~330 syscalls intercepted, most fully or partially implemented in Go                                       |
| Hardware support   | **Optional**. KVM platform uses hardware virtualization extensions for syscall interception; ptrace and systrap platforms need only standard kernel features                                                        |
| Isolation boundary | **Software (userspace-kernel reimplementation)** — the host kernel sees only Sentry's tightly-restricted syscalls (~50, controlled by a strict seccomp filter); guest syscalls never reach the host kernel directly |

The defining structural choice is **double indirection**: a guest syscall doesn't go to the host kernel, it goes to Sentry; Sentry decides what to do, and only makes host syscalls itself if absolutely necessary. The host-kernel attack surface available to a compromised guest is therefore *Sentry's* surface (small, audited, written in a memory-safe language) rather than the host Linux's surface (~330 syscalls, ~30M LoC of C).

Three rules to internalize:

1. **Sentry is a Linux kernel reimplementation, not a syscall proxy.** It maintains its own VFS, its own task/process state, its own signal delivery, its own TCP/IP stack. The host kernel sees a single process; inside Sentry there are guest tasks, guest fds, guest sockets.
2. **The host syscall surface that Sentry uses is tiny and locked down with seccomp.** Sentry's seccomp profile is hundreds of times more restrictive than Docker's container seccomp profile. The "kernel attack surface" measure is bytes-of-host-kernel-code-reachable, and gVisor minimizes it aggressively.
3. **The platform is how Sentry traps guest syscalls** — KVM (use a VM exit), ptrace (use ptrace's syscall stop), or systrap (use seccomp's user-notify). Three platforms, same Sentry above; the choice is mostly about host requirements and per-syscall cost.

## The stack

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  containerd / Docker / Kubernetes                                │
   │                                                                  │
   │  invoking gVisor via OCI runtime spec  ── --runtime=runsc ──┐   │
   └────────────────────────────────────────────────────────────┼────┘
                                                                ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  runsc — the OCI runtime CLI                                     │
   │  runsc create / start / exec / kill / delete                     │
   │  spawns Sentry + Gofer; manages their lifecycle                  │
   └────────────────┬────────────────────────────┬────────────────────┘
                    │                            │
                    ▼                            ▼
   ┌─────────────────────────────────┐   ┌─────────────────────────────┐
   │  Sentry (one process per VM)    │   │  Gofer (one process per VM) │
   │                                 │   │                             │
   │  - syscall handler              │   │  - 9P file server           │
   │  - VFS (in-memory file ops)     │   │  - serves /proc, /sys,      │
   │  - task / process state         │   │    container rootfs         │
   │  - signal delivery              │   │  - own seccomp profile,     │
   │  - virtual memory mgmt          │   │    even more restricted     │
   │  - netstack (TCP/IP in Go)      │   │  - sees real host files but │
   │  - platform: KVM/ptrace/systrap │   │    can't speak to network   │
   └────────────┬────────────────────┘   └─────────────┬───────────────┘
                │                                      │
                │  (sandbox 1)                         │  (sandbox 2)
                │  ↑ guest application syscalls        │  ↑ 9P requests
                │  intercepted by platform             │  over Unix socket
                ▼                                      ▼
        guest app process                       host filesystem
                ▲
                │
                │  application makes glibc syscall;
                │  platform layer traps it, hands to Sentry
                │
                ▼
        host kernel (sees only Sentry's tiny syscall surface)
```

Two key splits beyond the obvious "guest vs host":

- **Sentry and Gofer are separate sandboxed processes**, each with its own seccomp profile. Sentry handles syscalls; Gofer handles filesystem. They communicate over a Unix socket using the 9P protocol. Splitting them means a compromise of Sentry doesn't give arbitrary host filesystem access — the attacker would still need to compromise Gofer separately.
- **runsc is the user-facing OCI runtime**, but it exits after starting the sandbox. The running sandbox is the Sentry + Gofer pair, both supervised by an init-like process that exits when the sandbox is torn down.

## Sentry — the userspace kernel

Sentry (`pkg/sentry/`) is gVisor's heart: a substantial fraction of the Linux syscall ABI, reimplemented in Go. Sentry is one of the largest "userspace kernel" implementations ever shipped to production.

What Sentry implements:

| Subsystem | Path | Notes |
|---|---|---|
| Syscall dispatch | `pkg/sentry/syscalls/linux/` | ~330 syscall handlers, one Go function per Linux syscall; most for x86_64, fewer for arm64 |
| Tasks and processes | `pkg/sentry/kernel/` | `Task` (Sentry's analog of `task_struct`), threadgroups, signal masks, process trees |
| Virtual memory | `pkg/sentry/mm/` | Guest address-space management, mmap/munmap/mprotect/brk, copy-on-write fork |
| Virtual filesystem | `pkg/sentry/vfs/` | VFS layer with multiple filesystem types: procfs, sysfs, tmpfs, devpts, the 9P client (talking to Gofer), overlayfs |
| Networking | `pkg/tcpip/` | netstack — full TCP/IP stack in Go |
| Time, signals, IPC | `pkg/sentry/kernel/time/`, `pkg/sentry/kernel/signal*.go`, `pkg/sentry/kernel/sysv_shm.go` | Implementation of POSIX/Linux time, signal, SysV-IPC semantics |
| Limits, namespaces | `pkg/sentry/kernel/auth/`, namespace-related types | User-namespace, PID-namespace semantics inside Sentry |

What Sentry does *not* implement (gaps that drive its compatibility ceiling):

- Some syscalls return `ENOSYS` or `EPERM` (e.g., specialized `ioctl()` numbers, some `prctl()` operations, `bpf()`, `keyctl()`, `kexec_*`, kernel-module syscalls).
- Direct hardware access (`/dev/mem`, raw sockets, GPU device files) — applications needing these don't work under gVisor without explicit accommodation.
- Some advanced filesystem features (`fanotify`, `inotify` edge cases, some xattr behaviors).

The "Linux ABI compatibility" claim is *strong but not total*. The gVisor docs maintain a syscall-by-syscall compatibility table; production workloads that match common server-side patterns (HTTP servers, databases, language runtimes) usually run unmodified. Workloads needing weird kernel features (raw sockets, custom net hooks, hardware passthrough) don't.

### Why reimplement and not proxy?

A naive design would have Sentry just proxy each guest syscall to the host: catch it, validate args, forward to the host kernel. gVisor explicitly **rejects** this approach. The argument: if Sentry just proxies, the host kernel attack surface is unchanged — every syscall still reaches the host. Even with seccomp filtering on the proxy path, the kernel's syscall handlers still run, and any kernel bug in any of those handlers is exploitable.

By *reimplementing*, Sentry confines the kernel attack surface to the *reimplementation itself*. The host kernel sees only the tiny set of syscalls Sentry uses internally (memory allocation, vCPU control, signal delivery, file ops through Gofer's socket). Even if the guest application is malicious, the kernel surface it can reach is whatever Sentry chose to expose — typically a few dozen syscalls under a strict seccomp filter.

This is also why Sentry is written in Go: memory-safe by language, harder to write classes of bugs (use-after-free, buffer overflow) that plague C kernel code. Sentry has its own bugs, but the *class* of bug it has is bounded by Go's memory safety.

## The platforms — how Sentry intercepts guest syscalls

The platform layer (`pkg/sentry/platform/`) is gVisor's most architecturally interesting piece. The platform's job is to **run guest code and trap its syscalls**. Three platforms exist, each with very different mechanisms and trade-offs:

### KVM platform — Sentry as a VMM

Code in `pkg/sentry/platform/kvm/`.

The KVM platform turns Sentry into a userspace VMM that runs guest code in VMX non-root mode. Specifically: Sentry opens `/dev/kvm`, sets up a single-vCPU VM, places the guest application's memory in the VM's address space, runs the guest, and handles every VM-exit.

The clever part: **the guest application thinks it's running in ring 3 of a Linux process**, but in fact it's running in ring 3 of *Sentry's userspace VM*. The guest's "kernel" (ring 0 of the VM) is *also Sentry*, running its own code. When the guest does a syscall instruction, it traps as a VM-exit; Sentry catches the exit, decodes the syscall, services it from Go code, and resumes the VM.

Flow:

```
guest application
    │
    ▼  syscall instruction (e.g., write(2))
    │
    ▼  VM-exit (EXIT_REASON_SYSCALL or similar) — handled by KVM
host KVM module
    │
    ▼  KVM_RUN returns to userspace
Sentry (in KVM_RUN loop in Go)
    │  decode the guest's syscall registers (rax = syscall num, rdi/rsi/... = args)
    │  dispatch to Sentry's syscall handler for that number
    │  service the syscall (touch Sentry's VFS, netstack, etc.)
    │  write the return value back into guest's rax
    │
    ▼  call KVM_RUN again
guest application resumes
```

What makes this fast: the syscall trap is a VM-exit, which on modern hardware is a few thousand cycles — comparable to a normal syscall. No ptrace ceremony, no signal delivery, no userspace context-switching cost beyond the hypervisor trap.

What makes this require hardware: VMX (or AMD-V). KVM platform doesn't work on hosts without virtualization extensions, and doesn't work nested inside other hypervisors without nested-virt support.

Memory model: Sentry maintains the guest's address space inside the VM's EPT (or shadow page table). When a guest does `mmap()`, Sentry allocates host memory and updates the EPT to map it into the guest. The host kernel sees only Sentry's userspace memory allocation; the EPT mapping is invisible at the syscall layer.

Production default for performance-sensitive workloads. Used by Cloud Run and similar.

### ptrace platform — the original, slow, universal

Code in `pkg/sentry/platform/ptrace/`.

The ptrace platform uses Linux's `ptrace(2)` system call to trap guest syscalls. Sentry is the *tracer*; the guest application is the *tracee*. On every syscall the guest issues, the kernel stops the guest and notifies Sentry; Sentry decodes the syscall, services it, and resumes the guest.

Flow:

```
guest application
    │
    ▼  syscall instruction
    │
    ▼  PTRACE_SYSCALL stop — kernel notifies tracer
Sentry (in waitpid loop)
    │  ptrace(PTRACE_GETREGS) — read guest registers
    │  decode syscall number and args
    │  dispatch to Sentry's handler
    │  ptrace(PTRACE_SETREGS) — write return value to guest's rax
    │  set the guest's syscall number to a no-op so the kernel actually doesn't run it
    │  ptrace(PTRACE_CONT) — resume guest
    │
guest application resumes (with the return value Sentry wrote)
```

What makes this work everywhere: only needs ptrace, which has been in Linux forever. No hardware virt, no special kernel features.

What makes this slow: ptrace involves multiple round-trips between the tracer and tracee for every syscall — typically 4 context switches per intercepted syscall. The per-syscall cost is microseconds, not nanoseconds. ptrace platform is 2-5× slower than KVM on syscall-heavy workloads.

ptrace was the original gVisor platform when it was open-sourced in 2018. It's still useful for:
- Nested virtualization environments where KVM isn't available
- Hosts without hardware virtualization (rare today)
- Development and testing

### systrap platform — the modern fast path

Code in `pkg/sentry/platform/systrap/`. Introduced ~2022, became default-recommended for non-KVM environments in 2023.

systrap uses **seccomp-unotify** (a.k.a. `SECCOMP_USER_NOTIF`) and signal-based fast paths to intercept guest syscalls with much lower overhead than ptrace.

Mechanism: Sentry installs a seccomp filter on the guest with action `SECCOMP_RET_USER_NOTIF`. When the guest issues a filtered syscall, the kernel suspends the guest and delivers a notification via a file descriptor that Sentry reads. Sentry decodes the syscall, services it, and writes the response back via `ioctl(SECCOMP_IOCTL_NOTIF_SEND)`, which resumes the guest with the supplied return value.

For the very-common fast-path syscalls, systrap can also use **signal-based trapping**: it replaces the syscall instruction in the guest's text with an illegal instruction that raises SIGSYS, then handles the signal in a Sentry-installed handler. This avoids the seccomp-unotify round-trip for hot syscalls.

systrap gives most of KVM's speed without requiring hardware virtualization, at the cost of needing a relatively recent kernel (seccomp-unotify landed in 5.0, became performant in 5.5+). It's the recommended platform for nested or container-of-container environments where KVM is unavailable.

### Platforms compared

| Feature | KVM | ptrace | systrap |
|---|---|---|---|
| Per-syscall trap cost | VM-exit, ~thousand cycles | ptrace stops, multiple ctx switches per syscall | seccomp-unotify or signal, ~hundreds-thousands of cycles |
| Hardware requirement | VT-x / AMD-V | None | Recent kernel (5.5+) |
| Available nested? | Only if nested-virt works | Yes | Yes |
| Memory model | EPT / NPT | Standard userspace memory | Standard userspace memory |
| Production use | Default for hosts with virt | Legacy / dev | Default for hosts without virt |
| Throughput vs native | ~10-20% slowdown on syscall-heavy | ~50-100% slowdown | ~15-30% slowdown |

The platform layer is the most architecturally instructive aspect of gVisor: the **same Sentry** above three radically different syscall-trapping mechanisms below, with the platform abstraction hiding the difference. Reading the platform interface (`pkg/sentry/platform/platform.go`) is what makes the gVisor design click — it's the same shape as QEMU's accelerator vtable (see [QEMU](/virtualization/systems/qemu/) §5), one level removed.

## Gofer — the filesystem proxy

Sentry handles VFS calls (open, read, stat, etc.) by issuing 9P RPCs to a separate process called **Gofer** (`runsc/fsgofer/`). Gofer is the only thing in the gVisor sandbox that has direct host filesystem access; Sentry has none.

Why split? Defense in depth. If Sentry is compromised, the attacker has the syscall-intercept code but not direct filesystem access — they have to talk to Gofer through 9P, which Gofer's own seccomp profile constrains. Gofer can only see the specific filesystem subtree the container needs (its rootfs and bind mounts); it cannot reach outside that subtree.

```
guest application                     Sentry                     Gofer                    host kernel
─────────────────                     ──────                     ─────                    ───────────
open("/etc/hosts", O_RDONLY)
   │ syscall
   ▼  (intercepted by platform)
   │                                  Sentry VFS resolves
   │                                  "/etc/hosts" against the
   │                                  9P-mounted rootfs
   │                                  │
   │                                  ▼  9P Twalk + Topen over Unix socket
   │                                                              │
   │                                                              ▼  open(...) on host fd
   │                                                              ◀── host fd returned ──
   │                                                              ▼  9P Ropen with fd
   │                                  ◀── Ropen with handle ──
   │                                  Sentry installs a guest fd
   │                                  pointing at the 9P handle
   ◀── guest fd returned ──
   ...
read(fd, ...)
   │ syscall
   ▼  (intercepted)
   │                                  Sentry VFS reads via 9P
   │                                  ▼  9P Tread
   │                                                              │
   │                                                              ▼  read(host_fd, ...)
   │                                                              ▼  9P Rread with data
   │                                  ◀── data ──
   ◀── data ──
```

Performance implication: filesystem operations are slower than native or container-grade because of the 9P round-trip. gVisor mitigates with caching (Sentry caches readdir results, mmap'd file contents), but heavy-FS workloads pay a real cost. This is one of gVisor's most-discussed performance limits.

Gofer-FS-as-overlay: Gofer doesn't typically serve a raw host directory. It serves what containerd's snapshotter prepared — an OverlayFS mount with the container's image layers plus a private upper. From Gofer's perspective the rootfs is a regular directory; Gofer doesn't know about layers.

## netstack — userspace TCP/IP

`pkg/tcpip/`, ~250 KLoC of Go. A full TCP/IP stack: Ethernet, IPv4, IPv6, ARP, ICMP, UDP, TCP, with congestion control, retransmission, MSS clamping, all of it. One of the most substantial userspace network stacks anywhere.

When the guest application opens a socket, Sentry creates a netstack socket; when the guest does `send()`, netstack constructs packets and hands them to a host-side endpoint (typically a `fd_based` endpoint that writes to a host tap interface or AF_PACKET socket). Sentry's network endpoint is the only host-side network handle in the sandbox.

Why a userspace TCP stack? Same reason as the syscall reimplementation: minimize kernel attack surface. If guest network traffic went through host kernel sockets, the kernel's networking code (one of the most CVE-prone parts of Linux) would be in the attack surface. netstack pushes it into Go.

Performance cost: netstack's TCP performance is typically 30-60% of the host kernel's. For most workloads (HTTP, RPC, light networking) this is fine; for line-rate networking it's prohibitive. gVisor offers a "passthrough" mode (`--network=host`) that bypasses netstack and gives the sandbox a host fd directly, trading isolation for performance. This is a knob production users tune.

netstack is reusable as a library — the Tailscale userspace networking stack uses it directly.

## OCI integration — runsc

`runsc/` (~50 KLoC Go) is gVisor's CLI: an OCI-compliant runtime. To use gVisor with Docker:

```bash
$ docker run --runtime=runsc nginx
```

Or with containerd via a config file that registers `runsc` as a runtime handler. The `runsc` binary implements the OCI runtime spec — same commands as runc (`create`, `start`, `exec`, `kill`, `delete`, `state`) — but spawns Sentry + Gofer instead of doing the runc namespace-and-cgroup dance.

This is the magic that lets gVisor slot into existing Docker/Kubernetes pipelines without modification: any orchestrator that speaks OCI can run gVisor sandboxes by changing one config field. Same Docker image, same OCI runtime spec JSON, different runtime; same UX.

## End-to-end: `docker run --runtime=runsc nginx`

```
$ docker run --runtime=runsc -p 8080:80 nginx
   │
   ▼  Docker → containerd (gRPC), with runtime handler = runsc
containerd
   │  snapshotter prepares OverlayFS rootfs as usual
   │  generates OCI bundle (config.json + rootfs/)
   │  spawns containerd-shim, which invokes runsc create
   ▼
runsc create
   │  fork Gofer process; pass it the rootfs dir + a Unix socket fd
   │  install Gofer's seccomp profile (very restrictive)
   │  fork Sentry process; pass it the socket fd to Gofer + the OCI config
   │  install Sentry's seccomp profile (also very restrictive)
   │  Sentry initializes:
   │    - choose platform (KVM by default if available, else systrap)
   │    - set up an initial guest task with the OCI config's process spec
   │    - set up VFS root mounted via 9P on the Gofer socket
   │    - set up netstack with a host-side tap endpoint
   │    - set up the user namespace, cgroups, etc.
   │  Sentry waits for "start" signal
   ▼
runsc start
   │  signal Sentry to dispatch the first guest task
   ▼
Sentry runs nginx's _start:
   │  guest execve("/usr/sbin/nginx", ...) — intercepted, serviced by Sentry's exec
   │  guest mmap, brk, openat for nginx's config — intercepted, serviced
   │    (openat goes via Gofer for filesystem files)
   │  guest socket(AF_INET, SOCK_STREAM, 0) — intercepted, creates a netstack socket
   │  guest bind / listen / accept — netstack handles
   │  packets arriving at host:8080 → docker iptables NAT → host tap → netstack → guest socket → nginx
   ...

When the container exits:
  Sentry detects all tasks gone, exits cleanly
  Gofer exits (its parent died)
  runsc cleans up
```

Two things to notice:

1. **Sentry never makes a syscall to the host kernel on behalf of the guest's syscall.** When nginx does `openat`, Sentry doesn't `openat` on the host — it talks 9P to Gofer. When nginx does `socket`, Sentry doesn't `socket` on the host — netstack handles it. The only host syscalls Sentry makes are its own internal needs (allocate memory, manage vCPUs, signal handling, etc.), and those are locked down by Sentry's own seccomp.
2. **The host kernel sees three sandboxed processes** (Sentry, Gofer, the sandbox supervisor) and no container processes — the guest application processes exist only inside Sentry. From `ps` on the host, nginx is invisible.

## Performance

The headline cost of gVisor is **the syscall trap**. Every guest syscall is intercepted, decoded, dispatched to Sentry, serviced (which usually involves Sentry code running, possibly more host syscalls, possibly a 9P or netstack round-trip), and resumed. By workload type, on the KVM platform:

| Workload type | Native baseline | gVisor (KVM platform) |
|---|---|---|
| CPU-bound (compute, no syscalls) | 1.0× | ~1.0× (negligible overhead) |
| Memory-bound (mmap, large RSS) | 1.0× | ~1.0-1.05× |
| Syscall-heavy (small reads/writes) | 1.0× | ~1.1-1.5× |
| TCP throughput (loopback) | 1.0× | ~0.4-0.7× (netstack) |
| Filesystem-heavy (many small files) | 1.0× | ~0.3-0.6× (9P/Gofer) |
| Container startup | seconds | ~3-5× longer (Sentry init) |

ptrace platform multiplies syscall costs by ~3-5×; systrap is roughly 1.5-2× the KVM cost.

The intuition: **gVisor is fast at compute, slow at I/O, slowest at filesystem**. Production deployments lean on the compute-fast property: short-lived, CPU-bound workloads (Cloud Functions, App Engine instances) are gVisor's sweet spot.

## Where gVisor sits in the isolation-mechanism design space

Updated comparison table including all systems studied so far in the survey:

| System | Isolation mechanism | TCB | Per-call cost | Performance ceiling |
|---|---|---|---|---|
| Xen (Type-1, disaggregated) | Hardware: per-domain PT + ring deprivileging or VMX non-root | Hypervisor + dom0 kernel | Hypercall: ~hundreds of cycles; VM-exit: ~thousand | Near-native with PVH/EPT |
| KVM (Type-2) | Hardware: per-VM EPT + VMX non-root | Linux kernel + KVM module + userspace VMM | VM-exit: ~thousand cycles | Near-native with virtio + vhost |
| hvisor (Type-1, separation kernel) | Hardware: static partitioning + Stage-2 PT | Small Rust hypervisor + zone0 Linux | Hypercall: hundreds of cycles | Near-native (no scheduling cost) |
| Docker (OS-level) | Software: kernel feature flags | Entire Linux kernel | Per-syscall: ~50–100 ns of BPF + LSM | Native — no virtualization overhead |
| **gVisor (userspace kernel)** | **Software: Sentry reimplements Linux ABI; host kernel only sees Sentry's tiny syscall surface** | **Sentry + Gofer + small host kernel surface** | **Per-syscall: hundreds of ns (KVM) to microseconds (ptrace)** | **10-50% slower than native depending on workload** |
| Kata Containers *(next note)* | Hardware: per-container microVM + EPT | Guest kernel + host kernel + VMM | VM-exit: ~thousand cycles | Near-native CPU, slower I/O |
| Astervisor (planned) | Language: Rust type system + ownership | OSTD + visor unsafe regions | Per-call: Rust function call (~ns) | Near-native, by hypothesis |

The pattern: **stronger isolation costs more per call; weaker isolation requires more shared trust.** gVisor sits in an interesting middle position: it gives up native speed (~10-50% slowdown) in exchange for *dramatically* reduced kernel attack surface. The TCB is smaller than Docker's entire kernel, but larger than a hypervisor's (Sentry is ~500 KLoC of Go).

The unique feature gVisor brings: **the isolation mechanism is itself memory-safe code**. Hypervisors and kernel-feature isolation both rely on C code (the hypervisor, the host kernel) — bugs in that C code are the dominant failure mode. Sentry being in Go bounds the *class* of bug available; this is the closest precedent in this survey for Astervisor's language-isolation pitch.

## gVisor vs Kata

These two systems answer the same question ("how to get container UX with stronger isolation than Docker?") in **opposite ways**:

| Axis | gVisor | Kata Containers |
|---|---|---|
| Mechanism | Reimplement Linux ABI in userspace (Go) | Run each container in a real Linux VM |
| What the guest sees | Sentry's syscall handler (Linux-compatible, with gaps) | Real Linux kernel (full compatibility) |
| What's in the TCB | Sentry (~500 KLoC Go) + small host kernel surface | Guest Linux kernel + VMM + host kernel + KVM |
| Compatibility | Subset of Linux ABI; some apps don't work | 100% Linux ABI by definition |
| Performance — CPU | ~native | ~native |
| Performance — syscalls | 10-50% slower per syscall | Native (in-guest); host syscalls require VM-exit |
| Performance — filesystem | Slow (9P via Gofer) | Faster (virtio-fs) but still VM-mediated |
| Performance — network | Slower (netstack) or native (passthrough) | Slower (virtio-net through VM) |
| Startup time | ~3× Docker | ~10× Docker (boot a kernel) |
| Memory overhead per container | ~30 MB Sentry+Gofer | ~50-100 MB guest kernel + agent |
| Density (containers per host) | High | Lower (per-container kernel cost) |
| Hardware requirement | Optional (depends on platform choice) | Required (VT-x / AMD-V) |
| Maturity / production use | Google internal scale (App Engine, Cloud Run) | Alibaba, Ant Financial, AWS niche workloads |
| Confidential computing | Limited | First-class (CoCo project on Kata) |

**When to pick gVisor**: hostile multi-tenant workloads where syscall reduction matters more than full compatibility; short-lived CPU-bound workloads (FaaS); environments where ~30 MB-per-container density matters.

**When to pick Kata**: workloads that need full Linux compatibility (custom kernel modules, advanced networking, hardware passthrough); environments where the host kernel is *itself* untrusted (Confidential Containers); workloads where startup time and density are less critical than hypervisor-grade isolation.

In the broader design-space view: **gVisor is software-only isolation pushed as hard as it can go**; **Kata is hardware-isolation retrofitted under a container UX**. Astervisor's language-isolation pitch is *neither* — it claims that compile-time type checks can give gVisor-like isolation without the per-syscall runtime cost, while staying lighter than Kata's per-container kernel overhead.

## Architecture matrix

A single-system summary, in the same shape as the matrices in [Docker](/virtualization/systems/docker/) / [KVM](/virtualization/systems/kvm/) / [QEMU](/virtualization/systems/qemu/):

| Topic | gVisor |
|---|---|
| **Placement** | Userspace sandbox; not a hypervisor, not a kernel-feature container |
| **Guest CPU** | Runs as host process (ptrace/systrap) or in VMX non-root (KVM platform); Sentry schedules guest tasks within the platform |
| **Guest memory** | Sentry-managed virtual address space; KVM platform uses EPT, ptrace/systrap use host VAs |
| **Address space** | Sentry + Gofer + guest = three separate userspace processes |
| **Hardware support** | Optional — KVM platform uses VT-x/AMD-V; ptrace and systrap don't |
| **CPU virtualization mechanism** | KVM platform only |
| **Memory virtualization mechanism** | EPT (KVM platform) or none (ptrace/systrap) |
| **Device emulation** | None — Sentry implements specific devices in userspace (/dev/null, /dev/zero, /dev/urandom); no PCI/USB/etc. |
| **Filesystem** | 9P proxy to Gofer; Gofer serves the container's OverlayFS rootfs |
| **Networking** | netstack (Go TCP/IP) or host-passthrough |
| **Storage** | Volumes / bind mounts via Gofer; tmpfs in Sentry |
| **Syscall ABI** | Linux syscall ABI, ~330 syscalls intercepted, most implemented |
| **Image distribution** | OCI image spec via containerd (no gVisor-specific format) |
| **Container lifecycle** | runsc (OCI runtime) → Sentry + Gofer (sandbox processes) |
| **Isolation enforcement** | Sentry's reimplementation + Sentry/Gofer seccomp + host kernel as last resort |
| **TCB** | Sentry + Gofer + restricted host kernel surface |
| **Startup time** | ~hundreds of ms (3-5× Docker) |
| **Per-syscall overhead** | Hundreds of ns (KVM platform) to microseconds (ptrace) |
| **Steady-state CPU overhead** | ~0% on compute, 10-50% on syscall-heavy |
| **Memory overhead** | ~30 MB per sandbox (Sentry + Gofer + Go runtime) |

One-sentence summary: **gVisor is the design that gets stronger-than-container isolation by reimplementing the kernel ABI in userspace, paying for it in syscall latency rather than in startup time or hardware requirements.**

## Source map

```text
google/gvisor                          — the gVisor repo
├── runsc/                             — OCI runtime CLI
│   ├── cmd/                           — runsc subcommands (create, start, exec, …)
│   ├── container/                     — Container state machine
│   ├── sandbox/                       — Sandbox process management
│   ├── boot/                          — Sandbox bootstrapping
│   └── fsgofer/                       — Gofer implementation
├── pkg/sentry/                        — Sentry (the userspace kernel)
│   ├── kernel/                        — Tasks, threadgroups, signals, time, IPC
│   ├── mm/                            — Virtual memory management
│   ├── vfs/                           — Virtual filesystem
│   ├── fs/                            — Filesystem implementations (proc, sys, tmpfs, 9p, overlay)
│   ├── socket/                        — Socket implementations (netstack glue)
│   ├── syscalls/                      — Per-arch syscall dispatch
│   │   ├── linux/                     — Linux x86_64 syscall handlers
│   │   └── linux/arm64/               — Linux arm64 syscall handlers
│   ├── platform/                      — Platform abstraction
│   │   ├── kvm/                       — KVM platform
│   │   ├── ptrace/                    — ptrace platform
│   │   └── systrap/                   — systrap platform
│   ├── seccheck/                      — runtime audit / introspection
│   └── time/                          — virtual clocks
├── pkg/tcpip/                         — netstack
│   ├── transport/                     — TCP, UDP, ICMP
│   ├── network/                       — IPv4, IPv6
│   ├── link/                          — Ethernet, fd-based endpoints
│   └── stack/                         — Stack glue
├── pkg/p9/                            — 9P protocol library
├── pkg/seccomp/                       — seccomp filter builder (used for Sentry/Gofer profiles)
└── tools/                             — build tooling, syscall coverage reports
```

## Relationship to Astervisor

gVisor is the closest existing precedent in this survey for *software-implemented isolation that aspires to hypervisor-grade strength*.

| Choice | gVisor | Astervisor (planned) |
|---|---|---|
| Isolation mechanism | Userspace kernel reimplementation in memory-safe language (Go) | Compile-time type checks in memory-safe language (Rust) |
| Where isolation is enforced | Runtime: every syscall traps and dispatches | Compile time: types reject misuse before code runs |
| TCB size | Sentry (~500 KLoC Go) + restricted host kernel | OSTD + visor unsafe regions (small) |
| Per-call cost | Hundreds of ns to microseconds (syscall trap + dispatch) | Rust function call (~ns) |
| Compatibility | Linux ABI subset (best-effort) | Cooperating Rust guests (by design) |
| Performance ceiling | ~native CPU, 50-70% on I/O | Near-native, by hypothesis |
| Memory safety in TCB | Yes (Go in Sentry; small C surface) | Yes (Rust in visor; small unsafe surface in OSTD) |

### Cautionary lessons

- **Userspace kernel reimplementation is expensive to build and maintain.** Sentry is ~500 KLoC of Go and still has compatibility gaps. Every Linux syscall change risks breaking Sentry. The cost of "be your own kernel" is high; Astervisor's design — *cooperating* Rust guests, not unmodified Linux binaries — sidesteps this cost entirely. If Astervisor ever needs to host unmodified Linux workloads, it inherits some version of this maintenance burden.
- **Runtime isolation costs are real.** gVisor's 10-50% syscall overhead is the price of intercepting every syscall and servicing it in userspace code. Astervisor's pitch is that *types* can replace runtime checks: if the type system enforces a property at compile time, no per-call check is needed at runtime. Whether this translates to actual zero overhead is the project's central engineering question.
- **Compatibility is a long tail.** "Most workloads work" is gVisor's compatibility story, and the gap (raw sockets, custom ioctls, specific kernel features) is what excludes some users. Astervisor should explicitly *not* aspire to general Linux compatibility — the design space of "cooperating Rust guests" is where it can win.

### Positive lessons

- **Memory-safe language for the isolation mechanism is a genuine advance.** Sentry's Go implementation bounds the *class* of bug available — no buffer overflow, no use-after-free, no double-free. This is the closest precedent for Astervisor's Rust-isolation pitch, in actual production at Google's scale.
- **Splitting the sandbox into mutually-distrusting components (Sentry + Gofer) is good architecture.** Defense in depth: a compromise of one doesn't directly compromise the other. Astervisor's domain model can do the same — split language-isolated domains so even a Rust-unsafe compromise is contained by the domain boundary.
- **OCI compatibility is a force multiplier.** runsc as an OCI runtime means gVisor slots into every existing container ecosystem without modification. Astervisor should consider exposing its domains via an OCI-compatible runtime as a way to gain ecosystem composability even if domains aren't Linux containers in spirit.
- **The platform abstraction is exactly the right shape.** Same Sentry, three platforms below — KVM, ptrace, systrap — is the same architectural play as QEMU's accelerator vtable. Astervisor's vCPU model (or its equivalent) should have a similarly clean abstraction so different host-trap mechanisms can plug in without rewriting the upper layer.

## What this teaches that other notes don't

gVisor teaches a third path between *hypervisor* (Xen, KVM, Kata) and *shared-kernel container* (Docker), one neither has explored: **reimplement the kernel ABI in a memory-safe language, run it in userspace, intercept guest syscalls to dispatch to it**. The resulting system is:

- Not a hypervisor — no virtual CPU, no virtual hardware, no VMM in the [§03](/virtualization/vmm-architecture/) sense.
- Not a container — the guest doesn't share the host kernel; it talks to a userspace stand-in.
- Not a VM — there's no firmware boot, no real kernel running for the guest.

This third path has costs (compatibility gaps, syscall overhead) and benefits (drastically reduced kernel attack surface, memory-safe TCB, density between containers and VMs). It's the deepest precedent in the survey for *isolation by re-implementation in safe code*, which is conceptually adjacent to Astervisor's *isolation by language-level type-checking*.

The lesson: there is room in the design space between "share the kernel" and "give every workload a kernel". Astervisor is staking a claim further along that same axis — *no per-call cost*, *language-level enforcement*, *no kernel for the guest to share or have its own*. gVisor shows that such a path can work at production scale; the question is whether Astervisor can do it without paying gVisor's per-call cost.
