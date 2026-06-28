---
date: '2026-06-27T17:00:00+08:00'
draft: false
title: 'Virtualization Systems — KVM'
slug: 'kvm'
tags: ["Virtualization", "Hypervisor", "Systems", "KVM", "Linux"]
series: ["Virtualization Series"]
summary: "The canonical Type-2/hosted hypervisor: a Linux kernel module exposing the /dev/kvm ioctl ABI to userspace VMMs (QEMU, Firecracker, crosvm, cloud-hypervisor). The hosted shape pushed to its production conclusion — thin kernel hot path, everything else in userspace."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

KVM (Kernel-based Virtual Machine) is the in-tree Linux hypervisor: a kernel module that turns Linux itself into a Type-2 VMM by exposing hardware virtualization extensions through a small `/dev/kvm` ioctl ABI. It was published at the 2007 Ottawa Linux Symposium ([kvm: the Linux Virtual Machine Monitor](https://www.kernel.org/doc/ols/2007/ols2007v1-pages-225-230.pdf) (Kivity et al., OLS 2007)), merged into Linux 2.6.20 in the same year, and has been the default Linux virtualization stack ever since. The kernel side lives at `virt/kvm/` (architecture-generic) and `arch/<arch>/kvm/` (per-architecture); the userspace partner — QEMU, Firecracker, crosvm, kvmtool, cloud-hypervisor — is what the user actually launches.

What makes KVM worth reading carefully is that it concretely demonstrates the [§03](/virtualization/vmm-architecture/) *hosted* shape pushed to its production conclusion: the privileged hot path (vCPU run loop, second-stage page tables, exit dispatch, interrupt injection) is a thin kernel module sitting on top of Linux's scheduler, memory manager, and IRQ subsystem, while every device model, every control-plane operation, and every legacy emulation lives in a userspace process. KVM's split with QEMU — kernel below the `KVM_RUN` ioctl, userspace above it — is the design that every other Type-2 stack since 2007 has converged on.

This note follows the survey's chapter order. Source citations name canonical Linux paths (`virt/kvm/kvm_main.c`, `arch/x86/kvm/vmx/vmx.c`, `arch/x86/kvm/mmu/mmu.c`); without a pinned commit in this tree, file paths are stable across recent kernels but line numbers shift, so they are omitted. The userspace counterpart is treated as "the QEMU side" — [QEMU](/virtualization/systems/qemu/) covers device emulation in depth.

## §02 — Taxonomy: KVM at a glance

| Axis | KVM |
|---|---|
| Placement | **Type-2 hosted**, with a twist — the "host OS" is Linux, but guests run at *hardware* virtualization privilege (VMX non-root / SVM guest / EL1 with HCR_EL2.VM=1 / VS-mode), not as host-OS processes |
| Guest interface | Full virtualization (unmodified Linux/Windows/BSD), with paravirt accelerators (`kvmclock`, virtio, kvm-PV-EOI, kvm-PV-IPI) layered on for the hot paths |
| Hardware support | **Mandatory** on every architecture: VT-x/AMD-V + EPT/NPT on x86, ARMv8 virtualization extensions + Stage-2 paging, RISC-V H-extension + G-stage paging, POWER server-mode HV, s390 SIE |
| Isolation boundary | Hardware (per-VM second-stage page tables + privilege rings). Inside the host, additional Linux process isolation between userspace VMMs |

The defining structural choice is **using Linux as the hypervisor base**: instead of writing a scheduler, a memory manager, an IRQ subsystem, and a device-driver framework, KVM consumes Linux's. A vCPU thread is a Linux task scheduled by CFS. A VM's memory is a Linux `mm_struct` carved out of userspace VAs. An IRQ on an assigned device follows Linux's normal IRQ path until KVM redirects it. The hypervisor part — the code that knows about VMX — fits in a kernel module and a per-architecture subsystem.

## Type-2-with-extensions, before the details

KVM is conventionally called Type-2 because it lives in Linux, but the label is misleading in one specific way: **guests do not run as Linux processes**. They run in VMX non-root mode at whatever ring they choose, on physical CPUs whose VMCS Linux/KVM has loaded. The Linux kernel is the host OS in the placement-axis sense; it is *not* a software layer the guest steps through to reach hardware.

Three rules to internalize before the chapter detail:

1. **The kernel module owns the privileged hot path only.** Anything that doesn't need to run in kernel mode — device emulation, BIOS/firmware, image loaders, the control plane, migration logic — lives in userspace. The contract between the two is the `/dev/kvm` ioctl surface and a small set of shared mmap'd pages.
2. **There is no in-kernel control plane.** KVM has no equivalent of Xen's `xl create`. Userspace allocates a VM by opening `/dev/kvm` and calling `KVM_CREATE_VM`; the resulting fd represents the VM. Every subsequent lifecycle action is an ioctl on that fd (or on its vCPU/device child fds).
3. **One userspace process per VM is the canonical case but not the only one.** QEMU is one process per VM. Firecracker is one process per microVM. crosvm shards devices into separate processes for additional sandboxing. The kernel module is indifferent.

## §03 — Anatomy: what's in the kernel, what's in userspace

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │            VMM userspace process (QEMU / Firecracker / crosvm)        │
  │ ───────────────────────────────────────────────────────────────────── │
  │  device models (virtio-blk/net, IDE, PIIX3, e1000, IOAPIC*, ...)      │
  │  BIOS / firmware (SeaBIOS, OVMF)                                      │
  │  image loaders, snapshot/migration                                    │
  │  vCPU threads — each spinning in   ioctl(vcpu_fd, KVM_RUN, NULL)      │
  │  per-vCPU mmap'd kvm_run shared page                                  │
  └────────────────────────────────────┬──────────────────────────────────┘
                                       │ ioctl / mmap
  ┌────────────────────────────────────▼──────────────────────────────────┐
  │              Linux kernel  (KVM module + host kernel)                 │
  │ ───────────────────────────────────────────────────────────────────── │
  │  virt/kvm/         — arch-generic VM/vCPU lifecycle, MMU notifiers,   │
  │                      ioctl dispatch, irqfd/ioeventfd, dirty log       │
  │  arch/x86/kvm/     — VMX/SVM, MMU (TDP/shadow), in-kernel LAPIC/IOAPIC│
  │  arch/arm64/kvm/   — EL2 path, vGIC, Stage-2                          │
  │  arch/riscv/kvm/   — H-extension, AIA, G-stage                        │
  │  drivers/vhost/    — in-kernel virtio backends (vhost-net, -scsi)     │
  │  host Linux        — CFS scheduler, page allocator, IRQ subsystem     │
  └────────────────────────────────────┬──────────────────────────────────┘
                                       │  VMX VMLAUNCH / VMRESUME
                                       ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │                 guest (VMX non-root / EL1 / VS-mode)                  │
  │   guest kernel + guest userspace, running at hardware privilege       │
  └───────────────────────────────────────────────────────────────────────┘
```

*The split-irqchip mode places LAPIC in kernel and IOAPIC in userspace; the full in-kernel irqchip places both in kernel. See [§06](/virtualization/io/).*

Anatomy mapping per [§03](/virtualization/vmm-architecture/):

| §03 component | KVM location |
|---|---|
| Control plane | Userspace VMM (QEMU/Firecracker/crosvm); kernel exposes ioctls but holds no policy |
| vCPU model | `struct kvm_vcpu` (`include/linux/kvm_host.h`); per-arch state in `vcpu->arch` (`struct vcpu_vmx`/`vcpu_svm` on x86) |
| Memory model | `struct kvm_memslots` — userspace VA ranges registered as guest-physical regions; `arch/x86/kvm/mmu/` for EPT/NPT/shadow |
| Device model | **In userspace** by default; small fast-path exceptions in-kernel: LAPIC (`arch/x86/kvm/lapic.c`), PIT, IOAPIC, vhost backends |
| Interrupt/timer | In-kernel LAPIC + posted interrupts on capable hardware; `kvm_arch_timer` on ARM (vGIC + arch timer trap); `kvmclock` paravirt timer |
| Exit handler | Per-arch dispatch tables: `kvm_vmx_exit_handlers[]` (`arch/x86/kvm/vmx/vmx.c`), `svm_exit_handlers[]` (`arch/x86/kvm/svm/svm.c`), `handle_exit` on ARM/RISC-V |

### The three load-bearing data structures

Almost all KVM code revolves around `struct kvm`, `struct kvm_vcpu`, and the memslot machinery. Internalize their layout and the rest of `virt/kvm/` becomes navigable.

**`struct kvm`** (`include/linux/kvm_host.h`) — one per VM:

- **Identity & lifecycle**: `users_count`, `mm` (the userspace process's `mm_struct`), `created_vcpus`, `online_vcpus`
- **vCPU table**: `vcpus[KVM_MAX_VCPUS]` pointer array
- **Memslots**: `memslots[KVM_ADDRESS_SPACE_NUM]` — the userspace-VA → guest-PA mapping
- **MMU state**: `arch.mmu_page_hash` (shadow page cache), `tdp_mmu_pages` (modern TDP MMU), per-VM rmap
- **IRQ routing**: `irq_routing` — input GSI → output (LAPIC vector or MSI) table
- **Eventfd lists**: `irqfds`, `ioeventfds` — kernel-side endpoints for kernel-bypass signalling
- **Dirty-page log**: `dirty_ring_size` / per-memslot `dirty_bitmap`
- **mm_notifier**: `mmu_notifier` registration so KVM observes when host pages backing the guest get evicted/swapped/migrated by the host

Lifecycle: `kvm_dev_ioctl_create_vm` in `virt/kvm/kvm_main.c` → `kvm_destroy_vm` on last fd close. Two-phase destroy because vCPU threads may still be in-flight; refcounts drain before final teardown.

**`struct kvm_vcpu`** (`include/linux/kvm_host.h`) — one per vCPU:

- **Identity**: `vcpu_id`, `kvm` back-pointer, `cpu` (currently-running pCPU, or -1)
- **Run state**: `mode` (OUTSIDE_GUEST / IN_GUEST / EXITING_GUEST), `requests` bitmask (`KVM_REQ_TLB_FLUSH`, `KVM_REQ_EVENT`, ...)
- **Userspace shared page**: `run` — pointer to the `struct kvm_run` mmap'd into userspace (see "the run loop" below)
- **Per-arch state**: opaque `arch` substruct. On x86: VMCS pointer or VMCB, guest GPRs (saved on exit), XSAVE buffer, MSR cache, posted-interrupt descriptor, MMU context, in-kernel LAPIC
- **Wait queue & stats**: `wait` (used by HLT emulation when no work is available), `stat` counters

**The crucial property: a vCPU *is* a host thread.** The userspace process creates a thread per vCPU, opens the vCPU's fd, and that thread's existence on the runqueue is what makes the vCPU schedulable. KVM does not maintain a vCPU runqueue of its own — CFS does, by scheduling the host thread.

**`struct kvm_memory_slot`** (`include/linux/kvm_host.h`) — one per registered region:

- `base_gfn` — guest-physical start (in page frames)
- `npages` — region length
- `userspace_addr` — userspace virtual address that backs this region
- `dirty_bitmap` — set when dirty logging is enabled (for migration)
- `flags` — `KVM_MEM_LOG_DIRTY_PAGES`, `KVM_MEM_READONLY`

The invariant is the spine of KVM memory: **a guest-physical address is valid iff it falls in some memslot, and the host page backing it is the page Linux has at `userspace_addr + (gfn − base_gfn) × 4096`**. The MMU code in `arch/x86/kvm/mmu/mmu.c` walks memslots on every page fault.

## The control surface: `/dev/kvm` and its child fds

KVM has three levels of fd, each with its own ioctl namespace. This is the entire kernel API.

```
  /dev/kvm
   │
   │ open() → fd     ──ioctl()──▶ KVM_GET_API_VERSION
   │                              KVM_CHECK_EXTENSION
   │                              KVM_GET_VCPU_MMAP_SIZE
   │                              KVM_CREATE_VM → vm_fd
   │
   ▼  (per VM)
  vm_fd
   │
   │ ioctl(vm_fd) ──────────────▶ KVM_SET_USER_MEMORY_REGION
   │                              KVM_CREATE_IRQCHIP
   │                              KVM_IRQ_LINE / KVM_IRQFD
   │                              KVM_IOEVENTFD
   │                              KVM_SET_GSI_ROUTING
   │                              KVM_GET_DIRTY_LOG / KVM_CLEAR_DIRTY_LOG
   │                              KVM_CREATE_VCPU → vcpu_fd
   │                              KVM_CREATE_DEVICE → device_fd
   │
   ▼  (per vCPU)
  vcpu_fd
   │
   │ mmap(vcpu_fd) → struct kvm_run *
   │
   │ ioctl(vcpu_fd) ─────────────▶ KVM_RUN                ← the hot ioctl
   │                              KVM_GET_REGS / KVM_SET_REGS
   │                              KVM_GET_SREGS / KVM_SET_SREGS
   │                              KVM_SET_CPUID2
   │                              KVM_SET_MSRS / KVM_GET_MSRS
   │                              KVM_INTERRUPT
   │                              KVM_GET_VCPU_EVENTS / SET_VCPU_EVENTS
```

The ABI lives at `include/uapi/linux/kvm.h` — that file is the authoritative reference for everything userspace can ask KVM to do. The full ioctl set is large (~150 entries), but the steady-state hot ioctl is one: `KVM_RUN`. Everything else is setup, fix-up, or control plane.

`include/uapi/linux/kvm.h` is also where capability flags (`KVM_CAP_*`) are declared. Userspace queries them with `KVM_CHECK_EXTENSION` to discover what the running kernel supports — KVM's main extension mechanism, used in lieu of ABI versioning.

---

## §04 — CPU virtualization

The CPU model is the part of KVM that maps most directly onto [§04](/virtualization/cpu/). KVM commits hard to one design choice: **a vCPU is a host thread, and `KVM_RUN` is the syscall that turns the thread into a guest**.

### The run loop

The defining piece of code in all of KVM is the userspace-side loop:

```c
/* In QEMU's accel/kvm/kvm-all.c, in spirit (paraphrased): */
for (;;) {
    int r = ioctl(vcpu_fd, KVM_RUN, NULL);
    if (r < 0) handle_error();
    switch (run->exit_reason) {
        case KVM_EXIT_IO:        emulate_pio(run); break;
        case KVM_EXIT_MMIO:      emulate_mmio(run); break;
        case KVM_EXIT_HLT:       /* schedulable wait */ break;
        case KVM_EXIT_SHUTDOWN:  return;
        case KVM_EXIT_INTERNAL_ERROR: panic();
        /* …a few dozen exit reasons… */
    }
}
```

And the kernel-side counterpart in `arch/x86/kvm/x86.c::kvm_arch_vcpu_ioctl_run`:

```c
/* Paraphrased: */
for (;;) {
    if (vcpu->run->immediate_exit) return -EINTR;
    if (signal_pending(current)) return -EINTR;
    if (vcpu_run_needs_userspace_help(vcpu)) {
        vcpu->run->exit_reason = ...;          /* fill kvm_run */
        return 0;                              /* hands off to userspace */
    }
    kvm_x86_ops.vcpu_run(vcpu);                /* VMLAUNCH/VMRESUME */
    /* hardware returns here on VM-exit; vmx_handle_exit dispatches */
}
```

`kvm_run` is the mmap'd shared page through which kernel and userspace exchange exit reasons, MMIO data, IO port data, requested vCPU events, and a few status fields. Every `KVM_RUN` ioctl is potentially many VM-entries/exits — KVM only returns to userspace when it cannot handle the exit itself (the in-kernel handler list is intentionally small; see "Exit dispatch" below).

### Scheduling: CFS does it

KVM has **no vCPU scheduler**. The host's Completely Fair Scheduler treats each vCPU thread as an ordinary task:

- **vCPU runnable** → host thread on the runqueue, normal CFS picking.
- **Guest executes HLT (or PAUSE timeout)** → KVM blocks the thread on a waitqueue inside `KVM_RUN`; the thread leaves the runqueue.
- **Interrupt arrives for this vCPU** → KVM wakes the waitqueue; CFS puts the thread back on the runqueue.
- **VM-exit for any other reason** → still inside the ioctl; CFS only deschedules if the thread voluntarily blocks or its slice expires.

Consequences laid against [§04](/virtualization/cpu/)'s scheduling discussion:

- **No KVM-side priority/affinity model.** Use the host's: `sched_setaffinity` pins vCPU threads; `SCHED_FIFO` gives RT priority; cgroups cap CPU share. Cloud control planes set these from userspace.
- **Lock-holder preemption is a real pathology.** If a vCPU holding a guest spinlock is descheduled by CFS, peer vCPUs spin on the lock and burn host time. Mitigations: PLE (Pause-Loop-Exiting; VM-exits on long PAUSE loops → `kvm_vcpu_on_spin` yields the host thread), and the kvm-pv-spinlock paravirt interface for cooperating Linux guests.
- **Pinning is the cure for the noisy-neighbor and lock-holder problems both.** Production cloud VMs are typically vCPU-pinned, and the cloud's overcommit ratio is a policy on top of that.

### Trace 1: a guest changes its page-table root

The same operation traced for Xen, now in KVM with EPT (the default on any Intel CPU since Nehalem):

**With EPT (the universal modern case):** unmodified Linux executes `mov %eax, %cr3` directly inside VMX non-root. With CR3-store exiting disabled (the default on EPT machines), this **does not exit at all**.

```
guest kernel (VMX non-root)
   │  mov %eax, %cr3   ← executes natively
   │  guest's own CR3 changes
   ▼
guest continues; EPT continues translating
the guest-physical addresses the new guest PTs produce
```

KVM is not involved. There is no ioctl, no kernel code path, no userspace round-trip. This is the central performance reason hardware-assisted nested paging existed.

**Without EPT (legacy CPUs, or shadow MMU explicitly selected):** the path exits to KVM:

```
guest kernel (VMX non-root)
   │  mov %eax, %cr3
   ▼  ──── VM-exit ────  (CPU saves state to VMCS)
KVM vmx_handle_exit (arch/x86/kvm/vmx/vmx.c)
   │  exit_reason = CR_ACCESS
   │  dispatch handle_cr() in vmx.c
   │  kvm_set_cr3(vcpu, new_value)
   │   ├─ updates vcpu->arch.cr3
   │   └─ kvm_mmu_new_pgd() — re-roots the shadow MMU
   ▼  ──── VMRESUME ────
guest resumes
```

The shadow path lives in `arch/x86/kvm/mmu/` (`paging_tmpl.h` for the per-paging-mode walkers). It is maintained but exercised mostly by old hardware and by nested-virt L0 hypervisors running shadow for an L1 that lacks nested EPT.

Round-trip cost on a VM-exit is the standard "a few hundred to a few thousand cycles" of architectural save/restore plus the C handler work; the modern engineering effort has been to make exits not happen in the first place.

### Exit dispatch: where KVM does its real work

`vmx_handle_exit` in `arch/x86/kvm/vmx/vmx.c` is the spine of x86 KVM. It reads `vmcs.EXIT_REASON` and dispatches into a table of handlers, `kvm_vmx_exit_handlers[]`. Excerpting the most architecturally interesting entries:

| Exit reason | Handler | What happens |
|---|---|---|
| `EXIT_REASON_EXCEPTION_NMI` | `handle_exception_nmi` | Reflect the exception back into the guest, or — for #PF on shadow — fix up the shadow PT |
| `EXIT_REASON_EXTERNAL_INTERRUPT` | `handle_external_interrupt` | Let the host's IRQ subsystem handle it; KVM is just a passenger |
| `EXIT_REASON_TRIPLE_FAULT` | `handle_triple_fault` | Mark vCPU shutdown; return to userspace with `KVM_EXIT_SHUTDOWN` |
| `EXIT_REASON_IO_INSTRUCTION` | `handle_io` | Fill `kvm_run->io`; return to userspace with `KVM_EXIT_IO` *(unless ioeventfd matches)* |
| `EXIT_REASON_CPUID` | `kvm_emulate_cpuid` | Return KVM's curated CPUID view (set by `KVM_SET_CPUID2`) |
| `EXIT_REASON_HLT` | `kvm_emulate_halt` | Block vCPU thread on waitqueue until interrupt |
| `EXIT_REASON_VMCALL` | `kvm_emulate_hypercall` | Dispatch a KVM hypercall (kvm-pv-EOI, kvm-PV-IPI, etc.) |
| `EXIT_REASON_CR_ACCESS` | `handle_cr` | CR0/CR3/CR4 read/write — shadow PT path |
| `EXIT_REASON_EPT_VIOLATION` | `handle_ept_violation` | EPT-fault: page-in via memslot lookup → host page → install in EPT |
| `EXIT_REASON_EPT_MISCONFIG` | `handle_ept_misconfig` | Malformed EPT entry (used as a trampoline by emulated MMIO) |
| `EXIT_REASON_WRMSR` / `RDMSR` | `kvm_set_msr` / `kvm_get_msr` | MSR access policy; paravirt MSRs handled in-kernel, rest pass to userspace if KVM doesn't model them |
| `EXIT_REASON_APIC_ACCESS` | `handle_apic_access` | APIC mmio — handled by in-kernel LAPIC |
| `EXIT_REASON_APIC_WRITE` | `handle_apic_write` | APIC register write that EOI/ICR optimization didn't elide |
| `EXIT_REASON_VMLAUNCH`/`VMRESUME` | `handle_vmlaunch` / `handle_vmresume` | **Nested virtualization** — L1 guest is running its own L2 |

Two patterns are worth naming explicitly:

- **The handler list partitions naturally into "kernel handles" and "kicks to userspace".** EPT-violation, MSR, CPUID, HLT, CR-access, APIC, and the paravirt VMCALL family stay in the kernel. PIO, MMIO (when not caught by ioeventfd), and unmodeled MSRs return to userspace via `kvm_run`. The boundary is the QEMU/KVM split.
- **Many handlers exist solely to avoid round-trips that earlier KVM versions made.** The kernel LAPIC, kvm-pv-EOI (avoids an APIC EOI write exit), kvm-PV-IPI (issues an IPI via a hypercall that batches the LAPIC writes the guest would have done), `kvm-pv-tlb-flush` (host signals remote-vCPU TLB-flush without an IPI/exit), kvmclock (TSC offset + scale + a paravirt host-published timekeeping page). Each of these is a fast-path optimization for a hot exit that hardware originally required.

### Memory-state save/restore

Per-vCPU register state moves between hardware and software as follows:

- **GPRs**: not auto-saved by VMX (only RIP/RSP/RFLAGS go through the VMCS); KVM's assembly stub at `vmx_vmenter.S` saves them to the `vmx->guest_regs[]` array on exit and restores on entry.
- **Control regs, segment regs, RIP/RSP/RFLAGS, IDTR/GDTR/LDTR/TR**: auto-saved/restored by the VMCS (guest-state area).
- **FPU/XSAVE**: lazy — KVM saves the *host* FPU on entry and restores the *guest* FPU only when the guest touches FP/SIMD. `kvm_load_guest_xsave_state` / `kvm_load_host_xsave_state` in `arch/x86/kvm/x86.c`.
- **MSRs**: KVM maintains an in-VMCS auto-save list for hot MSRs (`STAR`, `LSTAR`, `SYSCALL_MASK`, `KERNEL_GS_BASE`, ...). Cold MSRs are read/written by hand only on demand.
- **Posted-interrupt descriptor**: one cacheline per vCPU, updated by the LAPIC code; hardware reads it on every entry to deliver any pending vectors without an exit.

---

## §05 — Memory virtualization

KVM's memory model is the cleanest realization of the [§05](/virtualization/memory/) "second-stage translation" picture, because it has had EPT/NPT/Stage-2 as a *first-class* assumption since Nehalem/Barcelona and has done years of work removing the legacy fallback paths.

### Translation pipeline

```
guest-virtual addr
       │  guest's own page table  ← guest writes freely, no exit
       ▼
guest-physical addr (gfn)
       │  KVM's second-stage table
       │  (EPT / NPT / Stage-2 / G-stage)
       │  populated lazily on fault from memslot info
       ▼
host-physical addr (pfn)
```

The second-stage table is per-VM, walked by hardware, and is the only structure KVM updates on the memory data path.

### Memslots: userspace VAs as the source of truth

The userspace VMM tells KVM which guest-physical regions are backed by which userspace-virtual regions, via `KVM_SET_USER_MEMORY_REGION`:

```c
struct kvm_userspace_memory_region {
    __u32 slot;
    __u32 flags;          /* KVM_MEM_LOG_DIRTY_PAGES, KVM_MEM_READONLY */
    __u64 guest_phys_addr;
    __u64 memory_size;
    __u64 userspace_addr; /* a pointer in the calling process's address space */
};
```

The guest's RAM is "just" some virtual memory in the userspace VMM's address space, registered with KVM. QEMU typically uses `mmap(MAP_ANONYMOUS | MAP_SHARED, ...)` to get an anonymous region for guest RAM, then registers it.

This single mechanism quietly carries enormous engineering weight:

- **All host memory policies apply for free**: NUMA placement (`mbind`/`numactl`), huge pages (`mmap(MAP_HUGETLB)` or `madvise(MADV_HUGEPAGE)`), `mlock`, KSM (`madvise(MADV_MERGEABLE)`), reclaim, swap, memory cgroups. KVM does not reimplement any of these; the host kernel already has them.
- **Memory can be backed by anything `mmap`-able**: anonymous pages, tmpfs files, hugetlbfs, real files (for file-backed guest memory), or shmem (for sharing between VMs and userspace daemons like vhost-user). Same registration call, different `mmap` target.
- **mmu_notifier integration ties it together**: when the host kernel moves a page (compaction, NUMA balancing) or unmaps one (swap), it calls registered `mmu_notifier` callbacks. KVM's callback (`virt/kvm/kvm_main.c`'s mmu notifier ops) tears down the corresponding EPT entries before the host page goes away. Without this, the guest could read stale physical memory.

### The MMU subsystem

`arch/x86/kvm/mmu/` is the part of KVM that gets revisited most often, and exists in two implementations in modern kernels:

- **Legacy "shadow" MMU** (`mmu.c` + `paging_tmpl.h`) — the original design, retained because (a) shadow PT is still used when EPT is unavailable or for nested guests, and (b) the data structures (`struct kvm_mmu_page` rmap chains) double as the cache for direct-MMU pages.
- **TDP MMU** (`tdp_mmu.c`) — Two-Dimensional Paging MMU, added in 2020 for EPT/NPT/Stage-2 only. RCU-based, with finer-grained locking, dramatically better scalability for large VMs (lots of memory + many vCPUs faulting in parallel).

The shadow MMU was a pre-EPT design that grew an "also do EPT" path; the TDP MMU was a clean-slate redesign once the legacy shadow path was no longer the critical case. Both coexist; userspace can choose.

**Trace: an EPT fault on first guest access to a page.**

```
guest (VMX non-root)
   │  mov (%rdi), %rax       ← first access to a guest-physical page
   ▼  ──── EPT violation → VM-exit ────
vmx_handle_exit
   │  exit_reason = EPT_VIOLATION
   │  exit_qualification → fault gfn, R/W/X
   ▼
handle_ept_violation (arch/x86/kvm/vmx/vmx.c)
   │
   ▼
kvm_mmu_page_fault (arch/x86/kvm/mmu/mmu.c)
   │  look up gfn in vcpu->kvm->memslots
   │     → find slot, compute hva = slot->userspace_addr + (gfn − slot->base_gfn) × 4096
   │  __gfn_to_pfn_memslot(hva)
   │     ├─ get_user_pages_fast(hva)  ← faults host page in if needed
   │     │  (host kernel may allocate, swap-in, etc. — KVM doesn't care how)
   │     └─ returns pfn
   │  install EPT entry: gfn → pfn with appropriate flags
   ▼  ──── VMRESUME ────
guest re-executes the mov; this time it succeeds
```

The work is split very deliberately: **KVM owns the second-stage table; the host owns the first-stage VA→PA mapping**. KVM never directly allocates a guest page — it calls `get_user_pages_fast`, which is the same path any host process uses to fault in a page.

### Overcommit: everything is free, courtesy of Linux

[§05](/virtualization/memory/)'s overcommit toolbox maps onto KVM almost trivially because the toolbox lives in the host kernel:

| Mechanism | KVM realization |
|---|---|
| Ballooning | `virtio-balloon` (frontend in guest, backend in QEMU); reaches `madvise(MADV_DONTNEED)` on host RAM to actually free it |
| Swap | Host swaps guest RAM transparently — it's just userspace memory; mmu_notifier evicts EPT mapping when swap-out happens |
| Page sharing (KSM) | `madvise(MADV_MERGEABLE)` on guest RAM; the host's KSM thread coalesces identical pages |
| Huge pages | THP transparently when guest RAM is `MADV_HUGEPAGE`; hugetlbfs explicitly for guaranteed large pages |
| Demand allocation | Default — pages are not allocated until the guest's first access faults them in |
| Live-migration dirty tracking | `KVM_MEM_LOG_DIRTY_PAGES` per memslot + the dirty ring; see §08 |
| Userfaultfd-driven post-copy | Userspace registers a userfaultfd on guest RAM; on guest access the fault is delivered to userspace, which can pull the page from elsewhere |
| Memory hotplug | Add a new memslot via `KVM_SET_USER_MEMORY_REGION`; guest sees it via ACPI hotplug events |

The contrast with Xen (where ballooning, page-sharing, log-dirty, hotplug each required hypervisor-side machinery) is the central engineering payoff of being hosted: **you get to call the host kernel**.

### IOMMU integration

For device passthrough, KVM relies on the host's VFIO subsystem (`drivers/vfio/`). VFIO programs the IOMMU to let the device DMA only into pages registered for the guest. The flow:

```
userspace VMM
   │  opens /dev/vfio/vfio, /dev/vfio/<group>
   │  binds device to vfio-pci driver
   │  VFIO maps guest memory regions into IOMMU page table
   │  configures interrupts via VFIO + KVM_IRQFD
   │  registers MMIO BAR mmaps in QEMU's memory tree → KVM sees them as memslots
   ▼
guest accesses device — MMIO is direct (memslot maps BAR), DMA goes
through IOMMU which translates guest-physical → host-physical the
same way as KVM's EPT does
```

KVM/VFIO is the standard cloud production path for SR-IOV NIC virtual functions, GPU passthrough, and NVMe passthrough.

---

## §06 — I/O virtualization

The KVM/QEMU split is most visible in I/O. **The kernel module does almost no device emulation**; it provides the trapping hooks and the few performance-critical fast paths, and everything else lives in QEMU/Firecracker/crosvm.

### I/O exits, by route

A guest accesses a virtual device by some combination of PIO (`in`/`out`), MMIO (load/store to an unmapped EPT region), or message-signaled interrupts. KVM's job is to route each access to the right handler — kernel or userspace, fast or slow.

```
guest mov %eax, (mmio_addr)
        │
        ▼  ─── EPT violation → VM-exit ───
KVM  handle_ept_violation
        │
        ├──  is the address an in-kernel device's MMIO region?
        │     yes → in-kernel handler (LAPIC, PIT, IOAPIC, vhost backends),
        │            VMRESUME without touching userspace
        │
        ├──  does it match a registered ioeventfd? (write-only, exact-value match)
        │     yes → just signal the eventfd; VMRESUME without exiting to userspace
        │
        └──  otherwise → fill kvm_run->mmio, return to userspace with KVM_EXIT_MMIO
              userspace QEMU dispatches to its device model; on return
              userspace puts result into kvm_run and calls KVM_RUN again

guest in/out %dx, %al
        │
        ▼  ─── IO instruction → VM-exit ───
KVM  handle_io
        │  check in-kernel PIC/PIT/PCI-config port handlers
        │  check ioeventfd registration
        │  otherwise: kvm_run->io, return KVM_EXIT_IO to userspace
```

**Three optimizations sit inside this picture:**

- **In-kernel irqchip** (`KVM_CREATE_IRQCHIP`): puts the LAPIC, PIC, and (optionally) IOAPIC inside the kernel. Without it, every LAPIC EOI or ICR write would be an MMIO exit to QEMU. With it, EOI/ICR/IPI are handled in-kernel in ~hundreds of cycles each. Hot APIC EOIs additionally take a kernel-bypass shortcut via the kvm-pv-EOI paravirt MSR.
- **ioeventfd** (`KVM_IOEVENTFD`): "when the guest writes value V to MMIO address A, signal this eventfd". A virtio frontend's `kick` doorbell becomes a single VM-exit that doesn't even need a userspace round-trip — the kernel writes the eventfd and resumes the vCPU; a userspace thread blocked on the eventfd wakes up asynchronously. This is the mechanism that decouples virtio's data path from the vCPU thread.
- **irqfd** (`KVM_IRQFD`): the inverse — "when userspace writes to this eventfd, raise GSI N to the guest". Lets a userspace device backend (or vhost in-kernel backend) deliver an interrupt without an ioctl per IRQ. Combined with posted interrupts, the interrupt can reach the guest vCPU **without exiting the running vCPU at all** if the vCPU is currently in non-root mode on another physical CPU.

The ioeventfd/irqfd pair is the kernel-bypass path that makes vhost (in-kernel virtio backends) competitive with full userspace virtio, and is the substrate that virtio's userspace data plane (vhost-user) is built on.

### Trace 2: virtio-net packet send, KVM + vhost-net

The kernel-bypass picture made concrete. The classical setup: virtio-net frontend in the guest, vhost-net backend in the host kernel, QEMU only present at setup time.

**Setup (once, when virtio-net is brought up):**

```
QEMU
  │  allocate virtio ring page in guest RAM (a memslot)
  │  open /dev/vhost-net, get vhost_fd
  │  ioctl(vhost_fd, VHOST_SET_OWNER)
  │  ioctl(vhost_fd, VHOST_SET_MEM_TABLE, memslots)   ← vhost learns guest mem layout
  │  ioctl(vhost_fd, VHOST_SET_VRING_ADDR, ring desc/avail/used pointers)
  │  ioctl(vm_fd,    KVM_IRQFD, {fd, GSI})            ← TX completion irq path
  │  ioctl(vm_fd,    KVM_IOEVENTFD, {fd, kick MMIO})  ← TX kick path
  │  ioctl(vhost_fd, VHOST_SET_VRING_KICK,  kick_fd)  ← vhost listens on kick
  │  ioctl(vhost_fd, VHOST_SET_VRING_CALL,  call_fd)  ← vhost signals via irqfd
  │  ioctl(vhost_fd, VHOST_NET_SET_BACKEND, tap_fd)   ← real network endpoint
```

**Per packet send:**

```
guest virtio-net
  │  fill descriptor in available ring
  │  write virtio queue notify MMIO  (the "kick")
  ▼   ─── EPT violation → VM-exit ───
KVM
  │  exit qualification matches the ioeventfd registered above
  │  KVM writes to kick_eventfd
  │  ── VMRESUME ──  (vCPU never sees userspace)
  ▼
guest continues
                                  ┌─── (asynchronously, on a host CPU) ───┐
                                  │ vhost-net kthread wakes on kick_fd     │
                                  │ reads descriptors from ring            │
                                  │ writes to TAP fd                       │
                                  │   ── packet on host's network stack ── │
                                  │ writes used ring entry                 │
                                  │ writes to call_eventfd                 │
                                  └────────────────────────────────────────┘
                                                  │
                                                  ▼
KVM  irqfd handler runs from interrupt context
  │  inject GSI into virtual IRQ chip → LAPIC vector
  │  if guest vCPU is currently running, deliver via posted-interrupt
  │  hardware: posted-interrupt notification IPI → CPU running vCPU
  ▼
guest receives interrupt without a VM-exit
```

**Cost summary for one TX packet:** one VM-exit (the kick), one host context switch (vhost kthread), zero user-mode round-trips, zero VM-exits for interrupt delivery (with APICv + posted interrupts). This is the design point virtio + vhost was built for and is why KVM-based clouds get away with running tens of thousands of VMs on commodity hardware.

The Xen analogue is the [§07](/virtualization/communication/) trace 2 (blkfront/blkback): rings + grants + event channels. KVM/virtio/vhost is the same picture with **memslots + posted interrupts + eventfds** taking the place of grant tables + event channels. The mechanisms are structurally the same — design pressure that virtio acknowledges, since virtio's specification was explicitly informed by Xen's earlier I/O rings.

### Userspace virtio (vhost-user) and out-of-process backends

For workloads where the device backend itself wants to be a separate process (DPDK packet forwarders, SPDK NVMe userspace stacks, snapshot-friendly device daemons), the vhost protocol is exported to userspace as **vhost-user**. The QEMU process and the backend process share a Unix socket; the backend process mmaps the guest's RAM (from the same hugetlbfs/shmem file QEMU used); the backend gets direct ring access without going through the kernel.

KVM's role in this case is unchanged: it still owns the second-stage page table, irqfd, ioeventfd. The kernel-bypass picture is the same; only the *receiver* of the kick is different.

### Device passthrough

Covered above in [§05](/virtualization/memory/)'s VFIO discussion. The guest sees a real PCI device; KVM is responsible for routing MSI-X interrupts via irqfd; the IOMMU constrains DMA to memslot-mapped pages.

For a typical cloud production VM the I/O mix is: **virtio-blk/-net via vhost** (fast path), **virtio-balloon and friends via QEMU** (control path), **occasionally SR-IOV NIC VF passthrough via VFIO** (latency-sensitive workloads).

---

## §07 — Cross-domain communication

This is the chapter that asks "how does the guest talk to the VMM, and how do the VMM's components talk to each other?". KVM's answer differs from Xen's in a structurally important way.

### Guest-to-host: hypercalls (sparse, mostly paravirt)

KVM has a hypercall ABI (`KVM_HC_*` constants in `include/uapi/linux/kvm_para.h`), invoked from the guest via `VMCALL` (Intel) / `VMMCALL` (AMD):

| Hypercall | Purpose |
|---|---|
| `KVM_HC_VAPIC_POLL_IRQ` | (historical, now subsumed by APICv) |
| `KVM_HC_KICK_CPU` | wake another vCPU — used by the pv-spinlock interface |
| `KVM_HC_CLOCK_PAIRING` | tightly couple guest TSC with host CLOCK_REALTIME |
| `KVM_HC_SEND_IPI` | kvm-PV-IPI: ask host to send IPIs to a vCPU mask in one exit instead of one APIC write per target |
| `KVM_HC_SCHED_YIELD` | guest tells host "I'm spinning, please run another vCPU first" — directed yield for pv-spinlock |

This is a **much smaller hypercall surface than Xen's** (~5 entries vs ~40). The reason is structural: in Xen, hypercalls are the *only* way for a guest to do many operations (page-table updates, event-channel sends, grant ops). In KVM, those operations don't exist — the guest does PTE writes natively (EPT translates), I/O signalling is a doorbell MMIO (`KVM_EXIT_MMIO` or ioeventfd, not a hypercall), and IRQ EOIs go via the LAPIC (in-kernel or paravirt). Hypercalls in KVM exist for things hardware alone can't do efficiently — directed yields, IPI batching, paravirt timekeeping.

KVM also exposes some **paravirt MSRs** (`MSR_KVM_*`) that the guest writes to publish or read shared state without an explicit hypercall:

- `MSR_KVM_SYSTEM_TIME_NEW` — the **kvmclock** clock-source. Guest publishes the address of a per-vCPU page; host writes TSC base, TSC frequency, wallclock offset into it; guest reads timekeeping data without trapping.
- `MSR_KVM_PV_EOI_EN` — kvm-pv-EOI. Guest publishes a flag page; host sets a "skip this EOI" bit when the next EOI is for an edge-triggered vector; guest checks the bit before issuing the APIC EOI write, skipping it (and the exit) when possible.
- `MSR_KVM_ASYNC_PF_EN` — async page-fault: when KVM has to swap in a guest page, instead of blocking the vCPU on the EPT fault, return to the guest with an injected "page not present, please run something else" notification.
- `MSR_KVM_STEAL_TIME` — host publishes per-vCPU "time stolen by the host scheduler" so the guest can subtract it from its idle accounting.

These paravirt features are all *additive accelerators*: an old or non-cooperating guest works without them, just slower.

### VMM-to-guest: in-kernel injection paths

KVM injects events into the guest through several mechanisms, layered from cheapest to most general:

1. **Posted interrupts** (Intel APICv / AMD AVIC). Hardware delivers interrupts into the running vCPU without any VM-exit. KVM updates the posted-interrupt descriptor; on the next vCPU entry (or via a notification IPI), the hardware injects the vector. This is the cheapest interrupt path on modern hardware.
2. **VMCS injection field** (`VM_ENTRY_INTR_INFO_FIELD`). Standard fallback: write the to-inject vector into the VMCS before entry; on entry hardware injects.
3. **Software-emulated interrupt** via virtual-LAPIC state in `arch/x86/kvm/lapic.c`. KVM keeps the guest's LAPIC state in `struct kvm_lapic`; updates on writes; chooses vectors to inject on entry.
4. **Userspace-injected interrupt** via `KVM_INTERRUPT` ioctl on a vCPU. Used by external irqchip mode; userspace QEMU computes interrupt routing and calls down.

### Kernel-to-userspace: the kvm_run page + exits

The "hypercalls" of the QEMU/KVM boundary are not VMCALLs — they are the exit-reason codes in `kvm_run->exit_reason`. Each is a synchronous request from the kernel to the userspace VMM:

- `KVM_EXIT_IO` — emulate this PIO
- `KVM_EXIT_MMIO` — emulate this MMIO
- `KVM_EXIT_HYPERCALL` — emulate this hypercall (rare; most are kernel-handled)
- `KVM_EXIT_SYSTEM_EVENT` — guest issued SHUTDOWN / RESET / S3 / CRASH; userspace owns lifecycle response
- `KVM_EXIT_DEBUG` — debug exception; gdbstub in QEMU handles it
- `KVM_EXIT_INTERNAL_ERROR` — KVM has lost confidence in the guest state and is bailing
- `KVM_EXIT_FAIL_ENTRY` — VMX VM-entry itself failed

Userspace handles each, writes any result back into the same `kvm_run` page (e.g., for an MMIO read, fill `mmio.data`), then calls `KVM_RUN` again. The kernel re-enters the guest at the *next* instruction (or replays the trapped one with the supplied data).

### Userspace-to-kernel: eventfds and ioctls

The reverse direction. Userspace pushes work into the kernel via:

- **ioctls** (synchronous, for setup and rare events): `KVM_INTERRUPT`, `KVM_SET_REGS`, `KVM_SET_USER_MEMORY_REGION`, ...
- **eventfds** (asynchronous, for hot paths): `KVM_IRQFD` lets userspace raise a GSI via a single `write(eventfd, ...)`. No ioctl context-switch overhead.
- **shared memory** (the kvm_run page, the paravirt feature pages): both sides read/write directly.

### Composition: virtio + vhost as the canonical pattern

Reading the [§06](/virtualization/io/) vhost-net trace through this lens, the mechanism set is:

| Concern | KVM mechanism | Xen analogue |
|---|---|---|
| Notification guest→host | MMIO kick → EPT exit → ioeventfd | I/O ring `req_prod` + EVTCHNOP_send |
| Notification host→guest | irqfd → posted interrupt | EVTCHNOP_send (the reverse direction) |
| Data transport | memslot pages directly shared (no grant) | grant table + I/O ring |
| Authorization | implicit: anything in a memslot is shared | explicit per-grant authorization |

The single most important architectural difference: **KVM has no grant tables**. Sharing is implicit in memslot registration — once a region is registered, the kernel module (and any vhost helper) can read/write it as ordinary host VAs. The trust model is correspondingly different: the host trusts the guest's memslots because the host *defined* them, and a guest cannot grant memory to anyone (there is nobody to grant to — there's just one VMM with full access already). Xen's grant-table machinery, by contrast, exists because Xen's *guests* need to grant each other access without trusting Xen unconditionally; KVM has no equivalent need because Xen-style guest-to-guest sharing is not part of KVM's model.

---

## §08 — VM management

KVM has no in-kernel control plane. Everything lifecycle-related is the userspace VMM's job; the kernel just exposes the ioctls.

### Boot, then VMs

Two-phase. Phase 1 is the host (a regular Linux boot — KVM is a kernel module that loads like any other). Phase 2 is each individual VM, run by a userspace VMM.

```
Phase 1 — host boot
   normal Linux boot (kernel, initrd, init, …)
        │
        ▼
   kvm.ko + kvm_intel.ko (or kvm_amd.ko) load
        ├ kvm_init in virt/kvm/kvm_main.c — register misc device /dev/kvm
        ├ kvm_x86_init_ops — arch hooks
        ├ hardware_enable_all — write CR4.VMXE on each CPU, enter VMX root
        ▼
   /dev/kvm is open to processes with the right permission
   /dev/vhost-net and friends become available

Phase 2 — userspace VMM creates a VM (per QEMU/Firecracker launch)
   userspace VMM process starts
        │
        ▼
   fd = open("/dev/kvm")
   vm_fd = ioctl(fd, KVM_CREATE_VM, type)
        │  → kvm_dev_ioctl_create_vm
        │     allocs struct kvm, registers mmu_notifier, sets fd ops
        ▼
   userspace mmaps guest RAM
   ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION) — for each region
   ioctl(vm_fd, KVM_CREATE_IRQCHIP) — in-kernel LAPIC/IOAPIC
   ioctl(vm_fd, KVM_CREATE_DEVICE)  — kernel-side device objects (vGIC on ARM, etc.)
   ioctl(vm_fd, KVM_IRQFD)          — irqfds for each device
   ioctl(vm_fd, KVM_IOEVENTFD)      — ioeventfds for virtio kicks
        │
        ▼
   for each vCPU:
       vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, id)
       kvm_run = mmap(vcpu_fd, KVM_GET_VCPU_MMAP_SIZE)
       ioctl(vcpu_fd, KVM_SET_CPUID2)
       ioctl(vcpu_fd, KVM_SET_REGS) / KVM_SET_SREGS / KVM_SET_MSRS
       fork a thread:  while (...) ioctl(vcpu_fd, KVM_RUN, NULL);
        │
        ▼
   guest is running
```

The trade-off this captures is the inverse of Xen's: KVM keeps the *kernel module* tiny by pushing every "domain-building" choice into userspace, where the boot-protocol parser, BIOS, firmware loader, and image loader live. The cost is that the userspace VMM is substantial code with substantial privilege.

### Userspace VMM landscape

The same `/dev/kvm` ABI supports multiple userspace VMMs, each with different goals:

| VMM | LoC | Goal | Distinctive trait |
|---|---|---|---|
| **QEMU** | ~1.5 M (C) | Compatibility; "every device you've ever heard of" | Universal device model library; BIOS/firmware (SeaBIOS/OVMF); supports migration, snapshots, dozens of machine types |
| **Firecracker** | ~50 K (Rust) | MicroVMs for serverless | Tiny device set (virtio-net/-blk/-vsock + serial), <125 ms boot, single-binary; designed for AWS Lambda/Fargate |
| **crosvm** | ~150 K (Rust) | ChromeOS VM substrate | Process-per-device sandboxing (each virtio device a separate seccomp+namespaces process); also the basis of Android Virtualization Framework |
| **cloud-hypervisor** | ~150 K (Rust) | Cloud workloads | Rust + virtio-only + live migration; spun off from Firecracker for non-serverless cloud |
| **kvmtool** | ~25 K (C) | KVM developer test harness | Intentionally minimal; useful for `kvm-unit-tests` |

The architectural lesson: **the kernel ABI is sufficient to support both 1.5 MLoC and 25 KLoC userspace VMMs**. There is no "right" amount of userspace code; different deployment regimes (legacy compat, serverless, cloud, embedded) make different choices on the same kernel substrate.

### Live migration

Live migration in KVM follows the same pre-copy pattern [§08](/virtualization/vm-management/) describes for Xen, but is implemented entirely in userspace. The kernel provides three primitives:

1. **Dirty-page logging.** Per-memslot: `KVM_MEM_LOG_DIRTY_PAGES` flag, `KVM_GET_DIRTY_LOG` / `KVM_CLEAR_DIRTY_LOG` ioctls. Optionally the modern **dirty ring** (`KVM_CAP_DIRTY_LOG_RING`), which is a per-vCPU ring buffer instead of a per-memslot bitmap — better for very-large VMs.
2. **vCPU state extraction.** `KVM_GET_REGS`, `KVM_GET_SREGS`, `KVM_GET_MSRS`, `KVM_GET_FPU`, `KVM_GET_XSAVE`, `KVM_GET_VCPU_EVENTS` retrieve everything the kernel has about a vCPU.
3. **`KVM_GET_NESTED_STATE` / `KVM_SET_NESTED_STATE`** for migrating nested-VM state.

Userspace orchestrates the pre-copy loop:

```
source userspace VMM                                  destination userspace VMM
────────────────────                                  ────────────────────────
1. open KVM, set up empty VM (memslots, vCPUs)
                          ◀──── handshake over TCP/RDMA ────▶
2. on source: enable dirty logging per memslot
3. read all guest RAM, stream to destination
                          ──── memory pages ─────────────────▶ allocate, populate
4. read dirty log; re-send dirty pages
                          ──── dirty pages ──────────────────▶
   repeat until dirty rate falls below threshold
5. pause vCPUs (stop calling KVM_RUN)
6. KVM_GET_REGS/SREGS/MSRS/FPU/etc + final dirty pages + device state
                          ──── final delta ──────────────────▶
                                                       7. KVM_SET_REGS/etc,
                                                          restart vCPU threads
8. destroy paused VM on source
```

Most of the migration code is in QEMU (`migration/`), not in the kernel. The kernel's role is to expose the bits userspace needs to read and write.

The hard cases mirror Xen's: pass-through devices don't migrate cleanly (no in-kernel state to extract — the device has state in *its* registers); QEMU device-model state must serialize cleanly (a long-running engineering tax); network reattachment requires same L2 segment or overlay.

### Snapshots

`KVM_GET_*` / `KVM_SET_*` are sufficient to serialize a paused VM to disk and restore it later. QEMU's `savevm`/`loadvm` (and Firecracker's snapshot/restore) build on this. The kernel has no first-class snapshot mechanism — it's userspace orchestration over the same primitives migration uses.

### Nested virtualization

KVM can host another hypervisor as L1. The hairy case: L1 issues VMX/SVM instructions (`VMLAUNCH`, `VMRESUME`, `VMREAD`, `VMWRITE`); L0 intercepts and emulates, maintaining a shadow VMCS that composes L0+L1 controls. When L2 exits, hardware exits to L0; L0 decides whether L0 handles it or forwards to L1's exit handler.

x86 nested code is in `arch/x86/kvm/vmx/nested.c` (Intel) and `arch/x86/kvm/svm/nested.c` (AMD). ARM nested support (KVM-as-L1 with NV2 extension) is more recent. Performance is workload-dependent: with **VMCS Shadowing** (Haswell+, 2013) some VMREAD/VMWRITE bypass L0; without it every L2 VMX instruction is an L0 exit. Used in production for AWS metal-instance nesting, CI inside cloud VMs, and Windows Hyper-V running inside Linux KVM.

### Confidential VMs

A modern addition: hardware support for VMs whose memory the host cannot read.

- **AMD SEV / SEV-ES / SEV-SNP** — memory encryption with per-VM keys; SNP adds attestation and integrity.
- **Intel TDX** — Trust Domain Extensions; full hardware enclave per VM.

Kernel code in `arch/x86/kvm/svm/sev.c` (SEV) and `arch/x86/kvm/vmx/tdx.c` (TDX). The interesting consequence is that **the host kernel — including KVM — can no longer freely read guest RAM**. mmu_notifier callbacks, dirty logging, live migration, all need new flows that respect the hardware boundary. KVM's confidential-VM support is an active area of upstream development.

### Architecture ports

x86 is canonical, but the same ABI works on:

- **ARM64** (`arch/arm64/kvm/`): EL2 path via `hyp/`, vGIC (`vgic/`), arch-timer trap-and-emulate. Notably uses a "split EL2" — most of KVM runs at EL1 like a normal kernel module, and only the trap entry / VMRunner runs at EL2 via `__kvm_vcpu_run`. Modern Linux's "protected KVM" (pKVM) inverts this: the EL2 portion is enlarged and isolates VMs even from the host kernel.
- **RISC-V** (`arch/riscv/kvm/`): H-extension, G-stage paging, AIA (Advanced Interrupt Architecture). Newer port; matures alongside RISC-V hardware.
- **s390** (`arch/s390/kvm/`): uses the SIE (Start Interpretive Execution) instruction; predates VT-x conceptually by decades.
- **POWER** (`arch/powerpc/kvm/`): server-mode HV; also a less-privileged PR mode for nested hosting.

The cross-arch lesson is that the `/dev/kvm` ABI generalizes: the ioctl surface is mostly identical, the per-arch differences are in the registers exposed via `KVM_GET_REGS` / `KVM_GET_SREGS` and the exit reasons specific to each ISA's virtualization mechanism.

---

## Architecture matrix

The KVM design at a glance, by chapter:

| Topic | KVM |
|---|---|
| **§04 guest exec mode** | Hardware non-root (VMX / SVM / EL1+HCR / VS-mode); no deprivilege trick |
| **§04 sensitive-op handling** | Hardware traps to host → `kvm_x86_ops.handle_exit` dispatch |
| **§04 vCPU = ?** | A host thread inside `ioctl(vcpu_fd, KVM_RUN, ...)` |
| **§04 scheduler** | CFS (host) — KVM has none of its own |
| **§04 hardware required** | Mandatory: VT-x/SVM/ARM-HE/RISC-V-H |
| **§05 memory translation** | EPT/NPT/Stage-2/G-stage (mandatory modern); legacy shadow path retained |
| **§05 memslots** | Userspace VAs registered as guest-PA ranges; host kernel's mm owns backing |
| **§05 overcommit** | Free — uses Linux's KSM, swap, THP, balloon, userfaultfd |
| **§05 dirty tracking** | Per-memslot bitmap or per-vCPU dirty ring |
| **§06 in-kernel devices** | LAPIC, PIC, IOAPIC, PIT; vhost backends in separate kernel module |
| **§06 userspace devices** | QEMU/Firecracker/crosvm/cloud-hypervisor — by default everything else |
| **§06 fast paths** | ioeventfd (kick), irqfd (irq), posted interrupts (vCPU never exits) |
| **§06 passthrough** | VFIO + IOMMU |
| **§07 guest→host hypercalls** | Tiny set (`KVM_HC_*`, ~5 entries); paravirt MSRs for high-frequency state |
| **§07 sharing model** | Implicit via memslots (no grant tables) |
| **§07 host→guest interrupt** | Posted-interrupt → VMCS injection → in-kernel LAPIC → userspace `KVM_INTERRUPT` |
| **§08 control plane** | None in kernel; entirely in userspace VMM |
| **§08 construction** | `KVM_CREATE_VM`, `KVM_SET_USER_MEMORY_REGION`, `KVM_CREATE_VCPU`, `KVM_RUN` |
| **§08 live migration** | Pre-copy in userspace; kernel provides dirty log + state get/set |
| **§08 TCB** | Linux kernel + KVM module + userspace VMM process |

One-sentence summary: **KVM is the design that gets a small kernel hypervisor by reusing Linux as the host OS, and the QEMU/KVM split is the design that gets a small kernel hypervisor by pushing everything that doesn't need privilege to userspace.**

## Source map

```text
virt/kvm/                                    — architecture-generic
├── kvm_main.c                               — module init, /dev/kvm misc device,
│                                              VM/vCPU lifecycle, KVM_RUN entry,
│                                              memslot management, mmu_notifier
├── eventfd.c                                — irqfd, ioeventfd
├── dirty_ring.c                             — per-vCPU dirty-log ring buffer
├── coalesced_mmio.c                         — batch repeated MMIO writes
├── async_pf.c                               — async page-fault delivery
└── vfio.c                                   — VFIO integration glue

arch/x86/kvm/                                — x86 KVM
├── x86.c                                    — arch-generic x86: KVM_RUN entry,
│                                              CPUID/MSR policy, kvm_x86_ops vtable
├── vmx/                                     — Intel VMX
│   ├── vmx.c                                — VM-entry/exit, vmx_handle_exit dispatch
│   ├── vmenter.S                            — entry/exit asm: GPR save/restore
│   ├── nested.c                             — nested VMX (L1 hosts L2)
│   ├── posted_intr.c                        — APICv posted interrupts
│   └── pmu_intel.c                          — virtual PMU
├── svm/                                     — AMD SVM
│   ├── svm.c                                — VMRUN entry/exit, dispatch
│   ├── nested.c                             — nested SVM
│   ├── sev.c                                — SEV / SEV-ES / SEV-SNP
│   └── avic.c                               — AMD's APICv equivalent
├── mmu/                                     — second-stage paging + shadow
│   ├── mmu.c                                — shadow MMU + arch-generic logic
│   ├── tdp_mmu.c                            — modern Two-Dimensional-Paging MMU
│   ├── paging_tmpl.h                        — paging-mode-specific walkers (template)
│   └── spte.c                               — second-stage PTE format
├── lapic.c                                  — in-kernel virtual LAPIC
├── ioapic.c                                 — in-kernel virtual IOAPIC
├── i8254.c, i8259.c                         — in-kernel PIT and PIC
├── irq.c, irq_comm.c                        — IRQ routing
├── hyperv.c                                 — Hyper-V enlightenments (Linux as L1 on Hyper-V)
└── pmu.c                                    — virtual perfctr framework

arch/arm64/kvm/                              — ARM KVM
├── arm.c                                    — arch-generic entry
├── hyp/                                     — code that runs at EL2
│   ├── vhe/                                 — VHE: EL2 = full kernel (modern Linux)
│   └── nvhe/                                — non-VHE: only the trap-handling stub at EL2
├── vgic/                                    — virtual GIC (v2 and v3+)
├── arch_timer.c                             — vtimer + ptimer virtualization
└── nested.c                                 — ARMv8.4 NV / NV2 nested support

arch/riscv/kvm/                              — RISC-V KVM
├── vcpu.c, vcpu_exit.c                      — H-extension trap dispatch
├── mmu.c                                    — G-stage paging
└── aia.c                                    — Advanced Interrupt Architecture

drivers/vhost/                               — in-kernel virtio backends
├── vhost.c                                  — generic vhost framework
├── net.c                                    — vhost-net
├── scsi.c                                   — vhost-scsi
└── vsock.c                                  — vhost-vsock

include/uapi/linux/kvm.h                     — THE ABI: every ioctl, every cap
include/uapi/linux/kvm_para.h                — guest-visible hypercall + MSR numbers
include/linux/kvm_host.h                     — kernel-internal struct kvm, struct kvm_vcpu
```

## Relationship to Astervisor

KVM is the antithesis-by-design to Astervisor on the placement axis — a Type-2 in-kernel module rather than a Type-1 framekernel hypervisor — but the *components* and the architectural decisions about which components live where are deeply instructive.

| Choice | KVM | Astervisor (planned) |
|---|---|---|
| Placement | Type-2 (Linux host) | Type-1 (Asterinas / OSTD host) |
| Guest interface | Full + paravirt accelerators (virtio, kvmclock) | Paravirt cooperating Rust |
| Hardware support | Mandatory VT-x/SVM/etc + EPT | Minimal — MMU + privilege rings |
| Isolation boundary | Hardware | **Language (Rust type system)** |
| Hypervisor proper | Linux kernel module (~25 KLoC arch-generic + ~50 KLoC arch-specific) | Small unsafe TCB in OSTD; `visor/` is `deny(unsafe_code)` |
| Device models | Userspace VMM (QEMU 1.5 MLoC, Firecracker 50 KLoC) | Device backends as language-isolated Rust domains |
| Scheduler | None (delegates to host CFS) | OSTD's scheduler (one already exists) |
| Memory allocator | None (delegates to host VM subsystem) | OSTD's allocators |
| Cross-domain comm | Memslots + eventfds + posted interrupts | Typed Rust channels |

**Positive lessons** — things KVM gets right that Astervisor should copy:

- **The hypervisor proper should be small and the device model should be elsewhere.** KVM's kernel module is a few tens of thousands of lines. Firecracker's userspace is another ~50 K. That's a complete production hypervisor in <100 KLoC of privileged code, achieved by ruthless boundary-drawing. Astervisor's "device backends are themselves domains" plan is the language-isolation analogue.
- **Reuse what's already there.** KVM doesn't write a scheduler, allocator, page-fault handler, or IRQ subsystem — Linux has them. Astervisor doesn't need to write them either — OSTD has them.
- **Kernel-bypass for hot paths is the engineering win.** ioeventfd + irqfd + posted interrupts mean the steady-state virtio data path can do **zero VM-exits and zero ioctl round-trips**. Astervisor's channel design should aim at the same property: a packet-send should not need to traverse the trusted base if both endpoints are sane domains sharing a typed queue.
- **A capability ABI scales to many VMMs.** KVM supports QEMU, Firecracker, crosvm, cloud-hypervisor, kvmtool — five wildly different policy choices over the same kernel surface. Astervisor's domain ABI should similarly aim to be a substrate, not a policy.
- **Paravirt accelerators are additive, not mandatory.** kvmclock, kvm-pv-EOI, kvm-PV-IPI, virtio are all opt-in. A cooperating guest gets them; an old or non-cooperating guest works without them. Astervisor's guest-side library can take the same shape: cooperating Rust guests use the typed channels, non-cooperating guests fall back to more expensive paths.

**Cautionary lessons** — things KVM does that Astervisor cannot (or should not) replicate:

- **The TCB is the entire Linux kernel.** Every line of Linux is trusted with respect to every KVM guest. That's tens of millions of lines. Astervisor's whole premise rejects this — the TCB is OSTD plus the parts of the visor that need `unsafe`, and that has to stay measurable.
- **Implicit memory sharing only works because there's one privileged domain.** KVM has no grant tables because the host trusts itself; if Astervisor wants guest-to-guest sharing without all guests trusting each other, it needs *some* form of explicit grant — likely typed Rust ownership/borrow into the channel, since the language already provides authorization vocabulary.
- **A 1.5 MLoC userspace VMM is the cost of compatibility.** QEMU exists because unmodified Windows expects a PIIX3 chipset and an emulated VGA. Astervisor's commitment to cooperating Rust guests is what *prevents* this expansion — but only as long as the project resists the temptation to chase unmodified-guest compatibility later. (The same warning applies to Xen's HVM expansion noted in [Xen](/virtualization/systems/xen/).)
- **Hardware isolation imposes its own TCB.** KVM depends on VT-x/EPT being implemented correctly; vulnerabilities like L1TF, MDS, Reptar, etc. have at various points let guests read host memory through hardware bugs. Astervisor's language-isolation premise specifically aims to *not* depend on this surface.

## What this teaches that xen.md doesn't

Reading KVM after Xen surfaces several lessons specific to the hosted shape:

- **What does "small hypervisor" look like when you have a host kernel underneath?** ~25 KLoC arch-generic + 50 KLoC arch-specific in the kernel module. That's the cost of just the privileged hot paths when you don't reimplement schedulers and allocators.
- **What does interrupt delivery look like at the limit?** Posted interrupts: the running vCPU sees an interrupt without any VM-exit. The mechanism doesn't exist in pre-2015 hypervisors and changes the cost analysis materially.
- **What does the [§06](/virtualization/io/) boundary look like in production?** ioeventfd + irqfd. A virtio kick is one VM-exit, an interrupt is zero. The userspace device backend wakes asynchronously on the eventfd; the data path doesn't bounce through ioctls.
- **What does a small userspace VMM look like?** Firecracker — 50 KLoC of Rust, microVMs that boot in <125 ms, the actual substrate of AWS Lambda. Compact enough to be a useful reference for Astervisor's domain-side tooling.
- **What is the engineering payoff of being hosted?** All of Linux's mm: KSM, swap, THP, NUMA, memory cgroups, userfaultfd. None reimplemented. Astervisor cannot copy that strategy verbatim (no Linux underneath), but it can use OSTD's primitives the same way KVM uses Linux's — and the design discipline ("the hypervisor does not reimplement what the framework already provides") is portable.

These are the lessons that make the [§03](/virtualization/vmm-architecture/) *hosted* shape concrete in the same way Xen made the *disaggregated* shape concrete. KVM is the system to read to understand both why hosted hypervisors won the cloud and what the limits of that win are.
