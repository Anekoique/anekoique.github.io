---
date: '2026-06-27T14:00:00+08:00'
draft: false
title: 'Virtualization Systems — Firecracker'
slug: 'firecracker'
tags: ["Virtualization", "Hypervisor", "Systems", "Rust", "microVM", "Firecracker"]
series: ["Virtualization Series"]
summary: "AWS's Rust microVM (~50 KLoC) on KVM, the production substrate for AWS Lambda and Fargate. The reference for what a VMM looks like when its requirements are aggressively bounded; jailer + Rust + minimal device set as defense in depth."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

Firecracker is **AWS's microVM** — a tiny Rust VMM (~50 KLoC) that runs on KVM and was built to be the substrate of AWS Lambda and AWS Fargate. It was open-sourced in 2018 at AWS re:Invent and is now used outside AWS by Kata Containers (as one of its hypervisor backends, see [Kata](/virtualization/systems/kata/)), Weaveworks Ignite, and several Kubernetes-on-microVM projects. The repository is at `github.com/firecracker-microvm/firecracker`. Firecracker uses the **rust-vmm** ecosystem of shared crates (KVM bindings, virtio implementations, vm-memory), some of which were extracted from Firecracker itself.

What makes Firecracker worth reading carefully — and what makes it different from any other VMM in this survey — is that it is the **production reference for "what does a VMM look like when its requirements are aggressively bounded?"** Where QEMU (see [QEMU](/virtualization/systems/qemu/)) supports ~30 guest architectures, ~10 host architectures, ~150 machine types, ~300 device models, and 5+ acceleration backends, Firecracker supports x86_64 and aarch64 guests on Linux/KVM hosts only, has one machine model (its own), implements virtio-net / virtio-blk / virtio-vsock / serial + i8042 keyboard and nothing else, and uses KVM exclusively. The headline architectural lesson is everything Firecracker *deliberately doesn't have*.

This note follows the structure established in [Docker](/virtualization/systems/docker/) / [gVisor](/virtualization/systems/gvisor/) / [Kata](/virtualization/systems/kata/) — the system's actual shape, not a forced §-template. The organizing principle is **minimization as design**: each section names a QEMU-style subsystem and shows what Firecracker has (often nothing) at that slot, with a forward-pointer to [QEMU](/virtualization/systems/qemu/) for readers wanting the contrast. Source citations name canonical paths in the Firecracker tree (`src/vmm/`, `src/api_server/`, `src/jailer/`, `src/devices/`, etc.). No pinned commit; paths are stable across recent releases.

## §02 — Taxonomy: Firecracker at a glance

| Axis | Firecracker |
|---|---|
| Placement | **Userspace VMM on KVM**, same as QEMU's KVM-accel mode (`kvm.md` covers the kernel side). Single binary per microVM, no in-process plugins, no userspace device daemons by default |
| Guest interface | **Full virtualization with paravirt I/O only**: unmodified Linux guests, virtio-net / virtio-blk / virtio-vsock for everything. No emulated legacy hardware. No BIOS — PVH direct kernel boot |
| Hardware support | **Required**: VT-x / AMD-V (KVM); aarch64 virtualization extensions on ARM hosts |
| Isolation boundary | **Hardware** (per-VM EPT + VMX non-root mode), reinforced by an external **jailer** process that wraps each Firecracker with seccomp + cgroups + namespaces + chroot + drop-to-unprivileged-UID before the VMM ever runs |

The defining structural choice is **one workload, ruthlessly executed**. Firecracker exists to be the VMM under AWS Lambda — a Lambda function is a short-lived, multi-tenant, untrusted workload that needs strong isolation, fast boot, and tiny memory overhead. Every Firecracker design choice is downstream of those requirements. Where a request doesn't apply to Lambda, Firecracker doesn't implement it.

Three rules to internalize:

1. **Firecracker is "QEMU minus 90% of QEMU".** It has the KVM-driving VMM hot path that [QEMU](/virtualization/systems/qemu/) describes and almost nothing else: no TCG (KVM only), no BIOS (PVH direct boot), no legacy devices (virtio-only), no QOM/qdev (a small Rust object model instead), no QMP (a REST API instead), no migration (snapshot/restore instead), no live device hotplug (the API supports config-only-pre-boot for most devices), no PCI bus (virtio-mmio + a few platform devices), no multi-arch machine types (one machine model, parameterized).
2. **The minimization is for performance and security, not for elegance.** Less code means less attack surface, faster startup, smaller memory footprint, easier to audit. AWS quotes <125 ms boot to userspace and ~5 MB VMM memory overhead per microVM. These numbers are the actual product requirements, not aesthetic preferences.
3. **The Rust + jailer + small surface combination is the security argument.** Firecracker is small enough to audit thoroughly; written in Rust to bound memory-safety bugs; sandboxed by the jailer to limit blast radius even if the VMM is compromised. The threat model assumes the *guest* may be malicious; the goal is that a guest-to-host escape requires defeating all three layers.

## The stack

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Orchestrator (Lambda control plane, Kata, Ignite, …)            │
   │  - launches and configures Firecrackers                          │
   │  - typically batches many microVMs per host                      │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │ REST API over Unix socket
                                         │ (or via jailer; see below)
                                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  jailer (optional but production-recommended wrapper)            │
   │  - applies cgroups, namespaces, seccomp, chroot, UID drop        │
   │  - execs Firecracker inside the jail                             │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │ exec
                                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  Firecracker VMM (single process)                                │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ API server thread (Tokio)                                  │  │
   │  │   serves REST on the unix socket                           │  │
   │  └─────────────────────────────┬──────────────────────────────┘  │
   │                                │ mpsc channel                    │
   │  ┌─────────────────────────────▼──────────────────────────────┐  │
   │  │ VMM thread                                                 │  │
   │  │   - receives API requests                                  │  │
   │  │   - processes device events                                │  │
   │  │   - manages snapshots, metrics, exit                       │  │
   │  └─────────────────────────────┬──────────────────────────────┘  │
   │  ┌─────────────────────────────▼──────────────────────────────┐  │
   │  │ vCPU threads (one per guest vCPU)                          │  │
   │  │   - each spinning in KVM_RUN                               │  │
   │  │   - vCPU exits handled inline (MMIO, PIO, IRQ injection)   │  │
   │  └────────────────────────────────────────────────────────────┘  │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │  ioctl /dev/kvm
                                         ▼
                            (KVM kernel module — see kvm.md)
                                         │
                                         ▼  VMX VMLAUNCH / VMRESUME
                            ┌─────────────────────────────┐
                            │  Guest VM                   │
                            │  - PVH-booted Linux kernel  │
                            │  - virtio-net, virtio-blk,  │
                            │    virtio-vsock, serial     │
                            │  - userspace                │
                            └─────────────────────────────┘
```

Three things to notice immediately, all in contrast to QEMU:

1. **One process per microVM.** No persistent daemon, no shared state between microVMs, no out-of-process device backends. A Firecracker is a single binary running a single microVM. Multi-process device backends (vhost-user) are *not* supported by design — they would multiply the security review surface.
2. **No central control daemon.** The orchestrator talks to each Firecracker's REST API directly. No equivalent of dockerd / containerd. Orchestration is the *caller's* problem; Firecracker just is a VMM.
3. **Threads, not processes, for the components.** API server, VMM, vCPUs are all threads in the same process. This keeps IPC cheap and the security model simple (one process to jail), at the cost of less internal isolation than e.g. crosvm's process-per-device model.

## What Firecracker has, by subsystem

The organizing principle of this section: for each subsystem QEMU implements, name Firecracker's slot at that position. Many slots are empty. The empty slots are the design.

### CPU — KVM only

Firecracker has **no TCG**, no Xen, no HVF, no WHPX. KVM is the only execution backend. The vCPU loop is a thread per guest CPU, each calling `ioctl(vcpu_fd, KVM_RUN)` and handling exit reasons. The exit handler is small because Firecracker emulates almost nothing — most KVM exit reasons just return an error (Firecracker explicitly refuses to handle them, on the grounds that they shouldn't happen for the supported guest configuration).

Per [KVM](/virtualization/systems/kvm/)'s §04, the run loop is the standard one: `KVM_RUN` returns, switch on `kvm_run->exit_reason`, dispatch. What's distinctive is the *small* set of exits Firecracker actually handles:

- `KVM_EXIT_IO` — for the i8042 keyboard controller (used by the guest to trigger reset) and serial console.
- `KVM_EXIT_MMIO` — for virtio device registers and the platform interrupt controller.
- `KVM_EXIT_HLT` — guest idled.
- `KVM_EXIT_SHUTDOWN` — guest triple-faulted or reset.
- `KVM_EXIT_INTR` — KVM got an interrupt while in guest; let the host handle it.
- `KVM_EXIT_INTERNAL_ERROR` — KVM lost confidence in guest state. Firecracker treats this as fatal.

That's effectively it. By comparison, QEMU's KVM accelerator handles every exit reason because it might host any guest configuration. Firecracker's narrow exit set is because it knows what its guests do.

**No CPU model fudging.** Firecracker exposes CPU features to the guest via CPUID, configurable via the REST API's CPU template feature. Templates exist for performance-equivalence across CPU generations (so a snapshot taken on one host can resume on another with the same effective ISA). This is a Lambda-specific concern: cross-host snapshot-restore for warm pools.

### Memory — one flat region, statically sized

Guest memory is **one contiguous region**, sized at configuration time, allocated via `mmap(MAP_ANONYMOUS | MAP_PRIVATE)` (or `MAP_HUGETLB` for huge pages, configurable). It's registered as a single KVM memslot. There's no `MemoryRegion` tree, no `AddressSpace` flattening, no memory overlap or aliasing.

There's also **no memory hotplug** in the QEMU sense. The microVM is configured with `memSize` once; that's its memory forever. Resize requires snapshot + restore with a larger size, or just relaunch.

**Memory ballooning is supported** via virtio-balloon, optional and disabled by default. When enabled, the host can reclaim guest memory (`madvise(MADV_DONTNEED)`) when the guest balloon driver gives it up. This is the only post-boot memory adjustment.

The simplification is structurally important: a one-region, no-mappings-tree memory model means almost no code, simpler reasoning about KVM memslot lifecycle, no flatten step on every config change. It's exactly enough for what microVMs need and nothing more.

### Devices — virtio-only, minimal

Firecracker's device list, exhaustive:

| Device | Purpose | Notes |
|---|---|---|
| `virtio-net` | Network | Single queue pair per device; multi-queue support added 2021+; vhost-net is *not* supported (see below) |
| `virtio-blk` | Block storage | One disk image file per device; backing by raw file or block device |
| `virtio-vsock` | Host-guest socket | The `AF_VSOCK` socket family; used for control-plane talk to in-guest agents |
| `virtio-rng` | Entropy source | Forwards from host's `/dev/urandom` |
| `virtio-balloon` | Memory reclaim | Optional, off by default |
| Serial (8250) | Console | Just enough for kernel printk and login shell |
| `i8042` keyboard | Reset trigger | Two ports emulated for guest-initiated reset |
| RTC (aarch64) | Wall clock | Just for time reads, not interrupts |

That's the whole device tree. By comparison, QEMU has ~300 device models. Firecracker has eight. The list is what AWS Lambda's guests need; anything else is not implemented.

**No vhost-net, no vhost-user, no in-kernel device backends.** This is a deliberate choice. vhost-net would speed up networking but expands the threat model — the kernel-side backend has access to guest memory and the host's networking stack. Firecracker's design refuses this trade. Networking goes through userspace virtio-net in the VMM thread; throughput is lower than vhost-net could deliver but the security review surface stays in Firecracker.

**No PCI bus.** Firecracker uses **virtio-mmio** to expose virtio devices. Each device gets a small MMIO region in the guest's physical address space, with the device's discovery happening via the kernel command line (`virtio_mmio.device=...` arguments). No PCI means no PCI emulation, no BAR allocation logic, no INTx routing, no IRQ remapping — and no way to use VFIO passthrough, which Lambda doesn't need.

**Devices live in the VMM thread** by default. Each device has an `EventManager`-driven event loop (see below) sharing the VMM thread's runtime. This is fine because the device set is small and the VMM doesn't do much else; it would break for QEMU's hundreds of devices.

### BIOS / firmware — none, PVH direct kernel boot

Firecracker has **no BIOS, no UEFI, no OVMF, no SeaBIOS**. It uses **PVH direct kernel boot**: the bootloader-style work that BIOS/UEFI would do is skipped entirely. The guest kernel is loaded directly into guest memory, and execution jumps to its entry point with a small boot info structure (`hvm_start_info`) describing memory and command line.

This saves seconds of boot time. SeaBIOS takes hundreds of milliseconds to do POST and load a kernel; OVMF takes more than a second to initialize UEFI services. PVH skips all of it. The microVM's boot path:

```
KVM_CREATE_VM
   → load kernel image into guest memory
   → load initrd (if any) at high memory
   → write hvm_start_info structure pointing at command line and memory map
   → set vCPU entry to kernel's PVH entry point
   → KVM_RUN
   → guest kernel boots, mounts initrd, execs init
```

No fw_cfg, no ACPI tables (Firecracker generates a *minimal* ACPI for x86 to declare CPUs and a few resources, but nothing like QEMU's full ACPI table generation). The guest needs to be configured with a "minimal Linux" kernel — Firecracker provides build instructions and a reference config.

ARM uses Device Tree instead of ACPI for hardware discovery; Firecracker generates a small DT blob.

### Machine types — one model, parameterized

Firecracker has **no machine type system**. There's no QEMU-style `pc-q35-*` / `microvm` / `virt` registry. There is one Firecracker machine, parameterized by:

- vCPU count
- memory size
- kernel image path + boot args
- list of attached drives
- list of attached network interfaces
- list of attached vsock devices
- optional balloon device
- CPU template (which CPUID features to expose)

That's the entire machine configuration. By comparison, QEMU's machine system is a hierarchy of ~150 types each with dozens of properties.

### Object system — small, ad hoc

Firecracker has **no QOM/qdev**. The Rust struct-and-trait model handles what QOM does for QEMU. Each device implements a small `VirtioDevice` trait; configuration parses to typed Rust structs via serde; lifecycle is plain Rust ownership.

There is *no* generic reflection, no property introspection by string name, no QMP-equivalent ability to set arbitrary properties at runtime. The REST API has a fixed schema (defined by an OpenAPI spec) — to change configurable behavior, you change the schema, you change the Rust types, you redeploy.

This is the right trade for Firecracker because its configuration surface is small and stable. QOM is justified when you have hundreds of devices that need uniform configurability; with eight devices, plain Rust types are enough.

### Migration — no live migration; snapshot/restore instead

Firecracker has **no live migration** in QEMU's pre-copy sense (the iterative dirty-page resend described in [QEMU](/virtualization/systems/qemu/)'s migration section). It has **snapshot/restore**: pause the VM, write the full memory image to a file, write the VMM state to another file, kill the VM. Later: load the files, restore vCPU/device state, resume.

Why no live migration? Because Lambda doesn't need it. Lambda's workloads are short-lived (often <1 second); migration's value (move workloads off draining hosts) doesn't apply to workloads that finish before the drain matters. AWS's broader fleet uses live migration for long-lived VMs in EC2, but Lambda's microVMs are torn down after each invocation cycle.

What snapshot/restore *is* used for: **warm pools**. AWS pre-warms Firecracker microVMs with the language runtime loaded, snapshots them, and restores from snapshot when a Lambda invocation arrives. This cuts "cold start" from seconds (boot + runtime init) to ~50 ms (restore). The snapshot/restore feature exists for this specific product requirement.

Snapshot format is documented and stable. It is not, however, a portable format across Firecracker versions or CPU families — those are explicit non-goals.

### Control plane — REST API, not QMP

Firecracker exposes its control surface as a **REST API over a Unix domain socket**, not as the JSON-RPC protocol QEMU uses. The API is defined by an OpenAPI 3.0 spec (`src/firecracker/swagger/firecracker.yaml`). Endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/boot-source` | PUT | configure kernel image and command line |
| `/drives/<id>` | PUT | attach a virtio-blk device |
| `/network-interfaces/<id>` | PUT | attach a virtio-net device |
| `/vsock` | PUT | attach the (single) virtio-vsock |
| `/balloon` | PUT/PATCH | configure virtio-balloon |
| `/machine-config` | PUT/PATCH | vCPU count, memory, CPU template |
| `/actions` | PUT | `InstanceStart`, `SendCtrlAltDel`, `FlushMetrics` |
| `/snapshot/create` | PUT | take a snapshot |
| `/snapshot/load` | PUT | restore from a snapshot |
| `/mmds` | PUT/GET/PATCH | guest-facing metadata service |
| `/metrics` | PUT | enable metrics flushing |

The pattern: configure everything via PUT/PATCH calls **before** issuing `InstanceStart`. After boot, the API surface is narrow — mostly snapshot, metrics, and a few hot configurations (balloon, network rate limits, MMDS).

REST instead of QMP because: it's simpler (no schema-generated marshallers), more familiar to AWS's orchestration layer, and easier to call from any language without a special library. The schema is small enough that an OpenAPI generator covers all clients.

**MMDS** (Microvm Metadata Service) deserves a mention: it's an in-VMM HTTP server that the guest can reach at a magic IP (typically `169.254.169.254`, mirroring EC2's IMDS). It serves metadata configured by the orchestrator. This is the mechanism by which a Lambda function inside Firecracker learns its instance metadata, IAM credentials, etc.

### Accelerators — KVM only

There is no accelerator framework. KVM is hardwired. No TCG, no plug-in vtable, no swap-at-runtime mechanism. The choice is justified by the deployment model: Firecracker hosts are always Linux with KVM available; nothing else is needed.

The cost: Firecracker can't run on macOS, Windows, or other hosts without porting effort. The benefit: less code, less abstraction, simpler reasoning.

## The Rust + rust-vmm story

Firecracker's choice of Rust matters for the survey because it's the largest production VMM in Rust, and Astervisor is a Rust hypervisor.

The codebase organization:

- **Single binary.** `src/firecracker/main.rs` is the entry. The VMM is not a library that other things embed; it's a binary that orchestrators spawn.
- **Workspace of crates.** ~30 internal crates plus shared crates from rust-vmm. Each crate is small and focused: `arch/` (per-architecture init), `cpu-template-helper/`, `devices/` (virtio implementations), `dumbo/` (small TCP/UDP for MMDS), `event-manager/` (epoll loop abstraction), `kvm-bindings/` (KVM ioctl bindings), `mmds/`, `seccompiler/`, `snapshot/`, `utils/`, `vm-allocator/`, `vm-memory/`, `vmm/` (the core), `vstate/` (vCPU state).
- **rust-vmm crates.** Several of the above came out of Firecracker and were extracted into `rust-vmm/*` for reuse: `kvm-bindings`, `kvm-ioctls`, `vm-memory`, `vm-superio`, `virtio-queue`, `linux-loader`. Other rust-vmm crates exist that Firecracker doesn't use (e.g., `vm-fdt` for ARM device trees — Firecracker does use this), but the shared crate ecosystem is mostly Firecracker-originated.
- **Threading model.** One process; threads for API server, VMM, vCPUs (one each), metrics. Communication via mpsc channels between API and VMM; via KVM and shared structures between VMM and vCPUs.
- **Tokio for the API server** but not for the VMM. The VMM runs a custom epoll-driven loop (`event-manager`) because Tokio's runtime semantics (work-stealing, async-await) don't fit the VMM's "react to KVM and devices in a single thread" pattern. This dual-runtime design is sometimes confusing but is necessary.
- **Almost no `unsafe`.** Audited; the few `unsafe` blocks are wrapped in safe abstractions with documented invariants. Most `unsafe` lives in the rust-vmm crates (KVM ioctls, vm-memory mappings) which are extensively reviewed.

The crate layout is a useful reference for Astervisor, particularly:

- `event-manager` — a small epoll-based event loop. Astervisor's domain runtime might want something similar.
- `vm-memory` — abstraction over guest memory, including bounds-checked accesses. Maps cleanly to Astervisor's typed-memory ideas.
- `seccompiler` — a Rust BPF compiler. Astervisor's security boundary may want something analogous for whatever syscall-restriction story it ends up needing.

## The jailer — defense in depth

`src/jailer/` is a small binary (~3 KLoC Rust) that wraps Firecracker for production deployment. It is **not** part of the VMM; it's a separate program whose only purpose is to set up an isolation environment before `exec()`ing Firecracker inside it.

### Threat model

Firecracker is small and written in Rust, but is *still*:
- C-level code (the Rust compiler emits machine code; the VMM has direct KVM access).
- Privileged (interacts with `/dev/kvm`, allocates memory, opens files).
- A potential attack target (a guest that escapes Firecracker would have host-process privileges).

The jailer's threat model: **assume Firecracker can be compromised, and limit blast radius**. Even if a guest escapes via a bug in the VMM, the attacker is inside a deeply restricted process and cannot reach anything outside the microVM's resources.

### The jailer sequence

When invoked with `jailer --id <microvm-id> --exec-file firecracker [other args]`, the jailer:

```
1. Parse arguments (microVM id, exec file, gid, uid, chroot dir, cgroup config)
2. Create a chroot directory: /srv/jailer/firecracker/<id>/root/
3. Move required files into the chroot:
   - Copy firecracker binary into the chroot
   - Bind-mount /dev/kvm, /dev/net/tun, the API socket into the chroot
4. Create cgroups for the microVM (CPU, memory, pids limits)
5. Create new namespaces: PID, NET, mount, IPC, UTS
6. setsid() — new session
7. Apply seccomp filter to restrict syscalls
8. chroot() into the prepared directory
9. setresuid() / setresgid() to drop to unprivileged UID/GID
10. exec firecracker binary (now path "/firecracker" inside the chroot)
```

After step 10, Firecracker is running:
- as an unprivileged UID
- inside a chroot containing only what it needs
- inside its own PID/NET/mount/IPC/UTS namespaces
- inside cgroups capping its resource use
- under a seccomp filter restricting it to ~30 syscalls (compared to ~330 total)

The seccomp filter is the most aggressive layer. Firecracker only uses a small set of syscalls (KVM ioctls, epoll, read/write, mmap, etc.); everything else is blocked. The filter is generated from a JSON spec (`resources/seccomp/*.json`) by Firecracker's own `seccompiler` crate.

### Comparison to Docker's seccomp

[Docker](/virtualization/systems/docker/) covers seccomp at length. The contrast with Firecracker's jailer:

- **Docker's seccomp** is *the guest's seccomp* — it filters the workload's syscalls. Docker's default profile allows ~280 syscalls; the guest is *the containerized application*.
- **Firecracker's jailer seccomp** is *the VMM's seccomp* — it filters Firecracker's own syscalls. The filter allows ~30 syscalls; the "guest" of this filter is the VMM, and the workload (the in-microVM Linux process) doesn't see this filter at all; it sees whatever its own (in-guest) seccomp policy is.

These are different layers. Docker filters what the workload can do to the kernel; Firecracker's jailer filters what the VMM can do to the kernel. Production deployment of Firecracker typically uses *both*: jailer outside, in-guest seccomp inside.

The defense-in-depth argument: a chain of independent restrictions where defeating one doesn't defeat the others. A guest must first escape the microVM (defeating KVM's hardware isolation), *then* compromise the VMM (defeating Rust's safety + the small audited surface), *then* escape the jailer's seccomp + chroot + namespaces + cgroups + UID drop. Each layer is independently small and auditable; together they make a guest-to-host escape much harder than any single-layer defense.

## End-to-end: a Firecracker microVM, from API to running guest

```
Orchestrator                    Jailer                   Firecracker            Guest
────────────                    ──────                   ───────────            ─────

1. Setup phase
   create the cgroup tree, chroot dir,
   ensure /dev/kvm, /dev/net/tun available
   │
2. spawn jailer with --exec-file=firecracker --id=fc-1 ...
   │
   ▼
                                 jailer init:
                                 - move files into chroot
                                 - create namespaces
                                 - apply cgroups
                                 - drop UID
                                 - apply seccomp
                                 - exec firecracker
                                                            │
                                                            ▼
                                                    Firecracker main:
                                                    - parse args (api socket path)
                                                    - start API server thread on socket
                                                    - block VMM thread waiting for config

3. PUT /boot-source { kernel_image_path, boot_args }
   PUT /drives/rootfs { path_on_host, is_root_device: true }
   PUT /network-interfaces/eth0 { host_dev_name: "tap0" }
   PUT /vsock { guest_cid: 3, uds_path: "/v.sock" }
   PUT /machine-config { vcpu_count: 1, mem_size_mib: 128 }
                                                            │
                                                            ▼
                                                    VMM thread: stage config
                                                    (no KVM calls yet)

4. PUT /actions { action_type: "InstanceStart" }
                                                            │
                                                            ▼
                                                    VMM:
                                                    - open /dev/kvm
                                                    - KVM_CREATE_VM
                                                    - mmap 128 MiB, register as memslot
                                                    - load kernel image into guest mem
                                                    - load initrd at high mem if present
                                                    - write hvm_start_info to guest mem
                                                    - configure virtio-blk, virtio-net,
                                                      virtio-vsock device models
                                                    - configure i8042, serial
                                                    - KVM_CREATE_VCPU
                                                    - set vCPU regs (entry = kernel
                                                      PVH entry point, rip = entry,
                                                      rax = magic, rbx = boot info)
                                                    - launch vCPU thread
                                                            │
                                                            ▼
                                                    vCPU thread:
                                                    KVM_RUN ─────────────────────► guest kernel
                                                                                     │
                                                                                     ▼ PVH boot:
                                                                                     - kernel reads
                                                                                       hvm_start_info
                                                                                     - sets up early
                                                                                       paging, GDT
                                                                                     - parses cmdline:
                                                                                       virtio_mmio.device=...
                                                                                     - inits virtio
                                                                                       drivers
                                                                                     - mounts root
                                                                                       (virtio-blk)
                                                                                     - execs init
                                                                                     - runs userspace

5. (running)
   - guest does virtio-net send:
     - virtio queue notify MMIO write
     - VM-exit, KVM_EXIT_MMIO, VMM thread handles
     - VMM thread reads ring, writes packet to tap fd
     - returns to vCPU loop, KVM_RUN

6. snapshot? PUT /snapshot/create
   - VMM pauses vCPU
   - VMM writes memory file (memSize MB)
   - VMM writes state file (vCPU, devices)
   - VMM signals snapshot done

7. shutdown? PUT /actions { action_type: "SendCtrlAltDel" } or just kill
   - guest sees keyboard reset → kernel shutdown
   - Firecracker observes shutdown
   - VMM exits, vCPU threads exit, process terminates
   - jailer's child terminates
   - orchestrator cleans up the cgroup tree, chroot
```

Two things to highlight:

1. **The configuration is all up-front and declarative**, ending with a single `InstanceStart`. There's no "create device after boot" path for most devices. This is deliberate: it lets Firecracker validate the entire configuration before allocating resources, and gives the orchestrator a clean "config, then start, then run, then teardown" lifecycle.

2. **Networking is via tap.** The orchestrator pre-creates a tap device on the host (typically inside the container's net namespace if Firecracker is inside one); Firecracker just opens it. There is no host-side network configuration done by Firecracker. The orchestrator handles bridges, iptables, VPC, all of that. This is the same pattern Kata uses (see [Kata](/virtualization/systems/kata/) §networking) and is the right separation: Firecracker is a VMM, not a network management plane.

## Snapshot/restore in depth

Snapshot/restore is the Firecracker feature most directly motivated by AWS Lambda's product requirements, and the most architecturally distinctive thing Firecracker has that simpler VMMs (like kvmtool) don't.

### Why snapshot/restore exists

Lambda's headline problem is **cold start**. When a Lambda function is invoked and no warm container exists, the user pays the time to: spin up a Firecracker, boot a Linux kernel, init the language runtime (Node.js, Python, etc.), load user code, run the handler. That can take seconds. For interactive workloads (user-facing APIs), seconds of cold start is unacceptable.

The snapshot/restore solution: take a snapshot of a microVM with the language runtime already initialized, and on cold-start invocation, **restore** instead of booting. Restore is ~50 ms versus ~1-3 seconds for boot. AWS calls this **SnapStart**.

### What's in a snapshot

Two files:

- **Memory file**: the raw contents of guest memory (`memSize` MB).
- **State file**: a serde-serialized struct of `MicrovmState` containing vCPU state (registers, MSRs, sregs), KVM device state (LAPIC, IOAPIC), virtio device states, VMM-level state.

Snapshot timing is significant: writing 128 MiB of memory to disk takes milliseconds even on SSD; the state file is small. Total snapshot creation ~10-100 ms. Restore is even faster because the memory file can be `mmap`'d rather than read.

### Diff snapshots

For warm pools where the orchestrator already has a baseline snapshot loaded, Firecracker supports **diff snapshots**: write only the pages that have been modified since the last snapshot, using dirty-page tracking. This is much smaller than a full snapshot and faster to write.

### Limitations

Snapshot/restore is *not* a portable format:

- Tied to the Firecracker version that created it (struct layout changes break loading).
- Tied to the host CPU family (CPU template helps, but not all features can be normalized).
- Not designed for archival storage; designed for warm-pool latency.

For comparison, [QEMU](/virtualization/systems/qemu/)'s migration framework has decades of compatibility-tested VMState declarations. Firecracker explicitly chose not to take on that maintenance burden — its snapshot format evolves with the codebase.

## Performance

Firecracker's performance has two relevant numbers: **boot time** and **steady-state overhead**.

### Boot time

AWS quotes <125 ms to userspace. This includes:

- jailer setup (~10 ms): chroot, namespace, cgroup, seccomp setup.
- Firecracker init (~5 ms): start API server, parse config.
- KVM init (~10 ms): create VM, vCPUs, memslot.
- Guest kernel boot (~50-80 ms): from PVH entry to mounted rootfs + init exec.

The lack of BIOS/UEFI is the biggest contributor. Compare to QEMU with SeaBIOS (~200-400 ms additional) or OVMF (~1-2 s additional).

Restore from snapshot is faster still: ~50 ms cold restore, ~10 ms warm restore (when the memory file is in page cache).

### Steady-state

Per [Kata](/virtualization/systems/kata/)'s performance section (which covers Firecracker as a Kata backend):

| Workload | Native | Firecracker | Notes |
|---|---|---|---|
| CPU-bound | 1.0× | ~0.97-0.99× | KVM overhead negligible |
| Memory-bound | 1.0× | ~0.97× | EPT walks; minimal overhead |
| Syscall-heavy (in-guest) | 1.0× | ~1.0× | In-guest syscalls don't VM-exit |
| TCP throughput | 1.0× | ~0.7-0.8× | userspace virtio-net (no vhost) |
| Filesystem | 1.0× | depends on host | virtio-blk to raw file/blockdev |

The throughput costs come from Firecracker's *deliberate* choices to avoid vhost-net and other in-kernel data planes. The same workload on QEMU+vhost-net would be faster — but at the cost of expanding the trust surface. Firecracker explicitly trades performance for security in this dimension.

Memory overhead: ~5 MB VMM resident plus the guest's configured RAM. By comparison, QEMU is ~20-30 MB VMM for a similar config, gVisor's Sentry+Gofer is ~30 MB. Firecracker is the smallest production-deployed VMM by this measure.

## Where Firecracker sits in the design space

Updated comparison table including Firecracker (slotted in next to QEMU and Kata):

| System | Isolation mechanism | TCB | Per-call cost | Performance ceiling |
|---|---|---|---|---|
| Xen (Type-1, disaggregated) | Hardware: per-domain PT + ring deprivileging or VMX non-root | Hypervisor + dom0 kernel | Hypercall: ~hundreds of cycles; VM-exit: ~thousand | Near-native with PVH/EPT |
| KVM (Type-2) | Hardware: per-VM EPT + VMX non-root | Linux kernel + KVM module + userspace VMM | VM-exit: ~thousand cycles | Near-native with virtio + vhost |
| **QEMU (KVM-accel)** | **Hardware via KVM** | **Linux + KVM + QEMU (~1.5 MLoC C)** | **VM-exit: ~thousand cycles** | **Near-native with vhost** |
| **Firecracker (KVM)** | **Hardware via KVM + Rust + jailer (defense in depth)** | **Linux + KVM + Firecracker (~50 KLoC Rust)** | **VM-exit: ~thousand cycles** | **~native CPU; ~70-80% of QEMU+vhost throughput on networking** |
| hvisor (Type-1, separation kernel) | Hardware: static partitioning + Stage-2 PT | Small Rust hypervisor + zone0 Linux | Hypercall: hundreds of cycles | Near-native (no scheduling cost) |
| Docker (OS-level) | Software: kernel feature flags | Entire Linux kernel | Per-syscall: ~50–100 ns of BPF + LSM | Native — no virtualization overhead |
| gVisor (userspace kernel) | Software: Sentry reimplements Linux ABI in Go | Sentry + Gofer + restricted host kernel | Per-syscall: hundreds of ns to microseconds | 10-50% slower depending on workload |
| Kata Containers (microVM-per-container) | Hardware: per-container microVM + EPT | Guest kernel + VMM + host kernel | In-guest syscall: native; host VM-exit: ~thousand cycles | Near-native CPU; slower I/O |
| Astervisor (planned) | Language: Rust type system + ownership | OSTD + visor unsafe regions | Per-call: Rust function call (~ns) | Near-native, by hypothesis |

The pattern: **Firecracker and QEMU sit at the same isolation point (hardware via KVM), but with dramatically different code-size and feature trade-offs.** Firecracker is what you get when you take QEMU's architectural shape and aggressively prune for a single workload class. The "TCB" and "Linux kernel" entries are identical between Firecracker and QEMU-KVM at the host-kernel level; the difference is in the *userspace VMM* TCB — 50K Rust vs 1.5M C. That's a 30× reduction in the part of the TCB that's most easily compromised and least carefully audited.

## Firecracker vs Kata vs gVisor — production triple

The three "stronger than Docker" answers compared:

| Axis | Firecracker (direct) | Kata Containers | gVisor |
|---|---|---|---|
| What's between guest and host | Hardware (KVM) + Firecracker VMM + jailer | Hardware (KVM) + a VMM (often Firecracker) + Kata runtime | Sentry (userspace kernel reimpl) |
| Compatibility | Full Linux (real kernel in VM) | Full Linux (real kernel in VM) | Linux ABI subset |
| Cold start | ~125 ms | ~150-300 ms (Kata + Firecracker) | ~few hundred ms (sandbox spawn) |
| Memory/workload | ~5 MB + guest kernel | ~20-50 MB + guest kernel | ~30 MB Sentry+Gofer |
| Networking | userspace virtio-net (no vhost) | usually virtio-net + tap | netstack (userspace) or passthrough |
| Filesystem | virtio-blk to file | virtio-fs / virtio-blk | 9P to Gofer |
| Orchestration model | one Firecracker per workload, managed externally | Kubernetes pods via Kata | OCI runtime drop-in |
| Production scale | AWS Lambda, AWS Fargate | Alibaba Cloud, Confidential Containers | Google App Engine, Cloud Run |
| Code language | Rust | Go (runtime) + Rust (agent + Dragonball) | Go |

**Picking between them in production:**

- **Direct Firecracker** is for AWS-like control planes that build their own orchestration. Maximum efficiency, minimum overhead, but you're writing your own scheduler.
- **Kata Containers** is for Kubernetes deployments that want hypervisor isolation. The orchestration is solved (Kata is OCI-compliant); the cost is Kata's added layer.
- **gVisor** is for workloads that prefer the syscall-interception model over the per-pod-kernel model. Lower memory per workload, syscall overhead, compatibility limits.

Firecracker is the lowest layer of these three. Kata uses Firecracker as one of its backends. gVisor is architecturally distinct from both. The three are not strict competitors — they cover different points in the orchestration-vs-isolation space.

## Architecture matrix

| Topic | Firecracker |
|---|---|
| **Placement** | Userspace VMM on KVM |
| **Guest CPU** | KVM-driven; one vCPU thread per guest CPU; standard exit dispatch |
| **Guest memory** | Single contiguous mmap'd region, registered as one KVM memslot |
| **Address space** | One flat guest physical address space; no MemoryRegion tree |
| **Hardware support** | Required: VT-x / AMD-V, KVM |
| **CPU virtualization mechanism** | KVM (only) |
| **Memory virtualization mechanism** | EPT (via KVM) |
| **Device emulation** | virtio-net, virtio-blk, virtio-vsock, virtio-rng, virtio-balloon, serial, i8042 — exactly this set |
| **Filesystem** | virtio-blk backed by raw file or block device |
| **Networking** | virtio-net backed by host tap (no vhost-net) |
| **Storage** | virtio-blk to file |
| **Syscall ABI** | Linux (in guest, talking to real Linux kernel) |
| **Image distribution** | Not handled — Firecracker is a VMM, not a container runtime; the orchestrator provides kernel + rootfs |
| **VMM lifecycle** | One process per microVM; configured via REST API; no daemon |
| **Isolation enforcement** | Hardware (EPT + VMX non-root) + jailer (cgroups/namespaces/chroot/seccomp/UID) |
| **TCB** | Linux kernel + KVM + Firecracker (~50 KLoC Rust) |
| **Startup time** | <125 ms boot, ~50 ms snapshot restore |
| **Per-syscall overhead** | Zero in-guest |
| **Steady-state CPU overhead** | ~1-3% |
| **Memory overhead** | ~5 MB VMM + guest RAM |

One-sentence summary: **Firecracker is the design that gets a 30× smaller VMM TCB than QEMU by ruthlessly bounding requirements to one workload class (Lambda/Fargate microVMs) and refusing every feature outside those requirements.**

## Source map

```text
firecracker-microvm/firecracker         — main repo
├── src/firecracker/                    — entry crate; main() and the orchestration binary
├── src/api_server/                     — REST API server (Tokio + custom)
├── src/jailer/                         — jailer wrapper binary
├── src/vmm/                            — the VMM core
│   ├── src/builder.rs                  — Vm construction
│   ├── src/lib.rs                      — top-level VMM state
│   ├── src/devices/                    — virtio devices, serial, i8042
│   │   ├── virtio/
│   │   │   ├── net/                    — virtio-net
│   │   │   ├── block/                  — virtio-blk
│   │   │   ├── vsock/                  — virtio-vsock
│   │   │   ├── rng/                    — virtio-rng
│   │   │   └── balloon/                — virtio-balloon
│   │   ├── legacy/                     — serial, i8042
│   │   └── pseudo/                     — bus dispatch
│   ├── src/vstate/                     — vCPU state, KVM wrappers
│   │   ├── vcpu/                       — per-vCPU thread
│   │   └── memory.rs                   — guest memory layout
│   ├── src/persist.rs                  — snapshot serialization
│   └── src/seccomp_filters.rs          — VMM-side seccomp
├── src/cpu-template-helper/            — CPUID template management
├── src/dumbo/                          — small TCP/UDP for MMDS
├── src/event-manager/                  — epoll-based event loop abstraction
├── src/mmds/                           — Metadata Service
├── src/seccompiler/                    — Rust BPF compiler (used for jailer + VMM filters)
├── src/snapshot/                       — snapshot file format
├── src/utils/                          — shared utilities
├── src/vm-allocator/                   — guest physical address allocator
├── src/vm-memory/                      — re-export / wrappers over rust-vmm's vm-memory
└── tests/                              — integration tests

External rust-vmm crates Firecracker uses (rust-vmm/*):
├── kvm-bindings                        — KVM ioctl struct bindings
├── kvm-ioctls                          — safe wrappers around KVM ioctls
├── vm-memory                           — guest-memory abstraction
├── vm-superio                          — serial, i8042, RTC
├── virtio-queue                        — virtio queue management
├── linux-loader                        — kernel image parsing (ELF, bzImage, PE)
└── vm-fdt                              — flat device tree (aarch64)
```

## Relationship to Astervisor

Firecracker is the most relevant existing production system for Astervisor's design conversation. The reasons:

| Choice | Firecracker | Astervisor (planned) |
|---|---|---|
| Language | Rust | Rust |
| Codebase size target | Small (~50 KLoC) | Small (TCB-bounded) |
| Isolation mechanism | Hardware (KVM) + Rust safety + jailer | Language (Rust types) + minimal hardware |
| Feature scope | Aggressively bounded to one workload class | Bounded to cooperating Rust guests |
| Crate organization | Workspace, focused crates, rust-vmm shared layer | TBD; could mirror this layout |
| Threading model | One process, threads for components, mpsc | TBD |
| Trust model | Defense-in-depth (Rust + audit + jailer) | Defense-by-language (types) + auditable OSTD |

### Cautionary lessons

- **"Small" is bought by saying no, repeatedly.** Firecracker is 50 KLoC because it refused vhost-net, refused live migration, refused multiple hypervisor backends, refused QOM-style introspection, refused PCI, refused multiple machine types, refused legacy devices. Each refusal was justified by the Lambda workload. Astervisor will face the same pressure: every refused feature is a smaller TCB; every accepted feature multiplies maintenance and audit cost.
- **Production deployment requires defense in depth even with Rust.** Firecracker's threat model assumes the Rust VMM *can* be compromised, despite Rust's safety guarantees. The jailer exists for exactly this case. Astervisor cannot assume its Rust + types story makes the VMM bulletproof; some equivalent of jailer-like external isolation should be in the design from the start.
- **Snapshot-restore complicates "small" significantly.** It's not in the original Firecracker design; it was added because Lambda needed it. The maintenance cost of snapshot format compatibility, CPU template management, and warm-pool integration is real. If Astervisor needs domain-level fast restore, design it in early; retrofitting is harder.
- **No PCI / no legacy is a viable choice but excludes some workloads.** Firecracker can't run Windows (no UEFI), can't do GPU passthrough (no VFIO), can't use SR-IOV. For Lambda this is fine; for Astervisor, knowing what workloads are *explicitly excluded* should be part of the project's stated scope.

### Positive lessons

- **The crate workspace organization is directly portable.** Firecracker's `vmm/`, `devices/`, `event-manager/`, `seccompiler/`, `snapshot/`, `vm-memory/` layout maps cleanly onto what Astervisor's own crate structure could look like. The rust-vmm ecosystem might even be reusable in places (vm-memory, virtio-queue).
- **REST-over-Unix-socket + OpenAPI is a good control-plane choice.** Simple, language-agnostic, machine-readable, no special library required. Astervisor's domain control plane should consider this over a custom protocol.
- **The api/vmm thread split with mpsc channels is a clean pattern.** Keeps the API responsive without blocking on VMM operations; keeps the VMM single-threaded for simplicity. Astervisor's runtime could use the same pattern: an external control thread plus a domain-execution thread (or per-domain threads).
- **PVH direct boot, when possible, is a substantial win.** Firecracker's <125 ms boot is largely PVH. If Astervisor's domain startup involves anything kernel-like, skipping BIOS/UEFI is the right default.
- **Aggressive seccomp on the VMM itself is straightforward Rust.** The seccompiler crate is small; the filter is JSON-defined. Astervisor's TCB could similarly enforce that the VMM (or its equivalent) makes only the host syscalls it needs.

## What this teaches that other notes don't

The QEMU note covers what a universal VMM looks like. Firecracker shows what the same architectural shape looks like when **the requirements are bounded**. The lesson is not "QEMU is bloated" — QEMU's size reflects the universality of its requirements, which are real. The lesson is that *given different requirements*, a 30× smaller VMM is achievable.

For Astervisor, this matters concretely: **the project's success depends on stating its requirements precisely and refusing everything outside them**. Firecracker's requirements are "AWS Lambda's hot path". Astervisor's are (something like) "cooperating Rust domains with language-isolation guarantees". Both can produce small, focused, deeply-audited codebases. The discipline is in saying no.

A second lesson, less obvious: **Rust + small surface + defense in depth is the production-validated isolation strategy for the userspace VMM TCB.** It's not "Rust alone" (Firecracker still uses the jailer) and it's not "defense in depth alone" (the jailer doesn't try to be Rust-equivalent). The combination is what AWS bet on for Lambda and what's been running at hyperscale since 2018. Astervisor's pitch — language isolation as a *third* axis on top of these two — has a clear production precedent to point at.

Together with [QEMU](/virtualization/systems/qemu/) (the universal-VMM extreme) and [Kata](/virtualization/systems/kata/) (Firecracker-as-Kata-backend orchestration), this note completes the picture of the modern KVM-userspace VMM design space: QEMU at one end (universal, large), Firecracker at the other (specialized, tiny), Kata showing how to compose them under a container API. Astervisor's place in this space is *off* the KVM-userspace axis entirely — it proposes a different isolation mechanism — but the engineering lessons about minimization, Rust crate organization, and defense-in-depth translate directly.
