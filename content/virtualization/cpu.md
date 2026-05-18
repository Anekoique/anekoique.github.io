---
date: '2026-05-17T15:00:00+08:00'
draft: false
title: 'Virtualization Series 04 — CPU Virtualization'
slug: 'cpu'
tags: ["Virtualization", "Hypervisor", "Systems", "CPU"]
series: ["Virtualization Series"]
summary: "How guest code actually runs on a physical CPU: trap-and-emulate, binary translation, paravirtualization, and hardware-assisted virtualization (VT-x, AMD-V). Plus vCPU scheduling, gang scheduling, and the exit-cost story."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The [previous section](/virtualization/vmm-architecture/) described the vCPU model as the component that holds a guest's processor state and arranges for it to execute. This section opens that box: how does guest code actually run on a physical CPU, what happens when it cannot, and how has the answer changed as hardware has evolved?

The chapter is organized around the question [Foundations](/virtualization/foundations/) established: *given the Popek–Goldberg condition, how does a VMM achieve safe and efficient guest execution on architectures that originally satisfied the condition, and on architectures that did not?* Three historical regimes answer the question differently — classical trap-and-emulate, software-only workarounds for non-virtualizable architectures (binary translation, paravirtualization), and hardware-assisted virtualization (VT-x, AMD-V) — and a fourth set of concerns (vCPU scheduling, multi-vCPU guests, exit cost) cuts across all three.

## Trap-and-Emulate, Revisited

The classical baseline, established in Foundations, is the **trap-and-emulate** discipline: the VMM runs the guest at a deprivileged CPU level; non-sensitive instructions execute natively; sensitive instructions trap into the VMM, which emulates them against the guest's *virtual* machine state and resumes execution.

What this looks like in practice on a virtualizable architecture is that the VMM maintains, for each vCPU, a software representation of the guest's privileged state — control registers, segment descriptors, page-table base, interrupt enable, current privilege level — and the trap handler translates each intercepted instruction into the appropriate read or write against that representation. A guest `MOV` to `CR3`, for example, traps; the VMM records the new guest page-table base in the vCPU's virtual `CR3`, installs whatever real translation structures the new guest page table now implies, and resumes the guest. The guest believes it changed `CR3`; the hardware never actually saw the change.

The pattern is conceptually clean and can be implemented in a small amount of code per sensitive instruction. Two practical observations matter for what follows:

- **Trap cost is the dominant overhead.** Each intercepted instruction costs a privilege transition, register save/restore, and dispatch. A guest workload that touches sensitive state frequently — kernel-heavy code, frequent system calls, page-table churn — pays this cost on a hot path. The history of CPU virtualization is largely the history of *reducing the number of traps* and *reducing the cost of each one*.
- **Trap-and-emulate is silently *also* doing memory virtualization.** Many of the instructions that trap (`MOV CR3`, `INVLPG`, `INVPCID`) exist precisely because they manipulate translation. The CPU and memory components of a VMM are coupled at this layer; they are separated in this survey only for exposition.

On architectures that satisfy the Popek–Goldberg condition (System/370, MIPS, recent ARM with virtualization extensions enabled), trap-and-emulate is sufficient. On architectures that do not — historically, x86 — it is not, and the VMM must resort to one of the techniques below.

## Software-Only Virtualization on Non-Virtualizable Architectures

[Foundations](/virtualization/foundations/) introduced the x86 virtualization gap: a small but irreducible set of instructions that are sensitive but not privileged, and that therefore execute silently in deprivileged mode without trapping. From the mid-1990s until the introduction of VT-x in 2005, two software techniques bridged this gap. They are largely of historical interest now, but the trade-offs they reveal recur in any system that tries to virtualize without complete hardware support.

### Binary Translation

In **binary translation** (BT), the VMM treats the guest code stream as input to a translator. Before any block of guest code executes for the first time, the translator scans it, emits a *translated copy* into a separate buffer, and runs the copy in place of the original. Non-sensitive instructions are emitted unchanged. Sensitive-but-non-privileged instructions are replaced with calls into the VMM that emulate the intended semantics against the guest's virtual state.

The translation is **dynamic**: it happens lazily as guest code is encountered, not ahead of time. Translated blocks are cached so the translation cost is paid once per unique code path, not once per execution. In steady state, a hot guest workload runs almost entirely from the translation cache.

```
guest code (read-only)            translation cache (executable)
┌──────────────┐                  ┌──────────────────┐
│ ...          │ ─── translate ─→ │ ...              │
│ POPF         │                  │ call vmm_popf    │
│ MOV CR3, eax │                  │ call vmm_set_cr3 │
│ ...          │                  │ ...              │
└──────────────┘                  └──────────────────┘
```

The technique was famously made practical by VMware in the late 1990s for x86. Three subtleties dominate any real implementation:

- **Code identification is hard.** On x86 in particular, code and data can interleave, instructions are variable-length, and the entry points into a basic block are not always statically determinable. A translator must conservatively decode and may have to invalidate cached translations when the guest writes to a page that holds previously-translated code.
- **Self-modifying code and JITs require special handling.** A guest JIT (a JVM, a JavaScript engine) generates code at runtime; the translator must detect writes to translation source pages and re-translate.
- **Performance is competitive but never quite native.** On the kernel paths where trap-and-emulate would dominate, BT can outperform a hardware-assisted VMM because it avoids the cost of every-trap world-switches by inlining emulation. On user-space-heavy workloads, the translator's overhead and cache footprint hurt. The early-2000s VMware result that BT could match or beat first-generation VT-x in some workloads is one of the surprising findings of the period.

Binary translation fell out of mainstream use as VT-x and AMD-V matured and improved. It remains relevant in any setting that lacks hardware virtualization support — embedded, retro, or cross-ISA emulation (where it overlaps with the broader use of dynamic translation in QEMU).

### Paravirtualization

In **paravirtualization** (PV), the VMM gives up the equivalence requirement: rather than work around non-virtualizable instructions by translating around them, it changes the *interface* the guest sees so those instructions never need to be issued in the first place. Each problematic operation — a sensitive instruction, an expensive trap, a slow device interaction — is replaced with an explicit call into the VMM, called a **hypercall**. The guest OS is ported to the hypercall interface; it knows it is virtualized and cooperates.

```
unmodified guest                paravirtualized guest
┌─────────────────────┐         ┌──────────────────────┐
│ MOV CR3, eax        │         │ HYPERCALL set_cr3    │
│ (sensitive — needs  │ ─port─→ │ (explicit, cheap)    │
│  some workaround)   │         │                      │
└─────────────────────┘         └──────────────────────┘
                                          │
                                          ▼
                                ┌──────────────────────┐
                                │ VMM dispatch table   │
                                │ → set_cr3 handler    │
                                └──────────────────────┘
```

Xen's original design (2003) is the canonical example. Xen exposed a paravirtual interface for CPU privileged operations, page-table updates, interrupts, and (via shared rings) I/O. The result was native-speed execution on x86 *without* binary translation and *without* hardware virtualization — at the cost of requiring a ported guest kernel.

The trade-off is well understood:

- **Performance.** Hypercalls are typically cheaper than traps because the VMM knows what the guest wants and need not decode an instruction. Batching is natural: a paravirtual guest can submit a batch of page-table updates in one hypercall instead of trapping on each.
- **Compatibility cost.** Closed-source operating systems cannot be ported; even open-source kernels must track the hypercall ABI as it evolves. The maintenance burden of paravirt-Linux ports drove Xen and the wider community toward hardware-assisted virtualization once VT-x became mature.
- **The interface is a contract.** Once a hypercall ABI is published, both VMM and guest are constrained by it. Changes are difficult; security-relevant changes especially so.

Paravirtualization for *full* CPU and memory virtualization is largely retired in production. **Paravirtual I/O** — `virtio` and its descendants — is universal: every modern hosted VMM uses paravirtual device interfaces for performance even when the guest is otherwise fully virtualized. This is treated in [§06 I/O Virtualization](/virtualization/io/).

### Comparison

The two software techniques sit at opposite ends of a transparency / cooperation axis:

| | Binary Translation | Paravirtualization |
|---|---|---|
| Guest awareness | unaware (transparent) | aware (cooperating) |
| Guest modification | none | substantial port |
| Compatibility | any guest OS | only ported guests |
| Mechanism | rewrite instruction stream | replace instructions with hypercalls |
| Cost model | per-block translation | per-call hypercall |
| Status today | largely retired (CPU); foundational in QEMU TCG | retired for CPU; universal for I/O (virtio) |

Both were responses to the same underlying problem — the x86 virtualization gap — and both were largely displaced by the third response, which solved the problem in hardware.

## Hardware-Assisted Virtualization

In 2005 (Intel VT-x, Pentium 4 662/672) and 2006 (AMD-V, Athlon 64), the two x86 vendors added CPU extensions that close the Popek–Goldberg gap directly: the hardware itself ensures that every sensitive operation by a guest causes a trap. Trap-and-emulate becomes possible on x86 without translation or guest cooperation. Essentially all modern x86 VMMs — KVM, modern Xen, Hyper-V, ESXi — are built on these extensions.

### The new operating mode

The extensions introduce a new CPU mode. Intel calls it **VMX root mode** (informally "ring −1"); the VMM executes here. Guests execute in **VMX non-root mode**, where the full ring 0–3 hierarchy remains visible to the guest but every privilege level is constrained by the VMM. The architectural picture:

```
                              VMX root mode
                           ┌──────────────────┐
                           │  VMM             │
                           └──────────────────┘
                                   ▲     │
                            VM-exit│     │VM-entry
                                   │     ▼
                           ┌──────────────────┐
                           │  guest (ring 0)  │  ← VMX non-root mode
                           │  guest (ring 3)  │
                           └──────────────────┘
```

Sensitive operations in non-root mode that would previously have escaped now cause a **VM-exit**: control transfers to the VMM, the guest's complete architectural state is automatically saved into a hardware-managed control structure, and the VMM's own state is restored. After handling the exit, the VMM issues a **VM-entry** and the guest resumes.

### The control structure

Each vCPU is associated with a hardware-readable control structure: the **VMCS** (Virtual Machine Control Structure) on Intel, the **VMCB** (Virtual Machine Control Block) on AMD. The structure contains:

- The guest's full privileged state, automatically saved on VM-exit and restored on VM-entry: control registers, segment state, MSRs, interrupt state, instruction pointer.
- The host's saved state, restored on VM-exit so the VMM finds itself in a known environment.
- **VM-execution controls** — bitmaps that select which guest operations cause VM-exits. The VMM can configure, for example, that writes to `CR3` exit but reads do not, that certain MSR accesses exit while others pass through, and that I/O port accesses to specific ports exit.
- **VM-exit information** — fields populated on each exit describing the reason: instruction that triggered it, faulting address, exit qualification.

The VMCS is the contract between hardware and VMM: by editing its execution-control bitmaps, the VMM tunes which operations the hardware will mediate and which it will let the guest perform freely.

### What VM-exit costs

VM-exit cost is the central performance number for any hardware-assisted VMM. A single exit/entry round-trip on contemporary hardware costs on the order of hundreds to low thousands of cycles — much less than a software trap-and-emulate cycle on first-generation hardware, but still expensive enough that workloads triggering many exits per second pay a measurable price.

Exit cost has several components:

- **Architectural save/restore.** Hardware automatically saves and restores the guest and host state described above. This is fast but not free.
- **VMM dispatch.** The VMM reads the exit reason, looks up a handler, and runs it.
- **Pipeline and TLB effects.** The pipeline drains; TLB entries may be invalidated. On long-running guests these microarchitectural effects add cycles that are not visible in simple benchmarks.

The natural optimization is to *reduce the exit rate*. This drives several design choices that recur throughout the chapters that follow: nested paging eliminates the exits that shadow page tables would have caused ([§05](/virtualization/memory/)), virtio with `ioeventfd` and polling eliminates I/O notification exits ([§06](/virtualization/io/)), and posted interrupts eliminate exits for interrupt delivery ([§06](/virtualization/io/) / interrupts).

### Generational improvements

VT-x and AMD-V have been extended substantially since 2006. The improvements are uniform in goal — fewer exits, cheaper exits, more state managed in hardware — and uniform in shape: each adds another category of operation that the hardware can perform on the guest's behalf without VMM intervention.

- **Extended Page Tables / Nested Page Tables (Intel EPT, AMD NPT).** A second hardware-walked translation layer eliminates shadow page tables and the exits they required. Treated in [§05 Memory Virtualization](/virtualization/memory/).
- **VPID (Virtual Processor IDs).** TLB entries are tagged with vCPU identity, so a VM-exit/entry no longer flushes the TLB.
- **APICv and processor-side Posted Interrupts (Ivy Bridge-EP, 2013).** Virtual local APIC accesses are handled in hardware, and IPIs / virtual interrupts can be posted to a target vCPU without VMM mediation.
- **VT-d Posted Interrupts (Broadwell-EP, 2016).** External interrupts from passed-through devices can be delivered directly to a guest vCPU running in non-root mode, without first exiting to the VMM.
- **VM Functions and VMCS Shadowing.** Targeted optimizations for nested virtualization — a VMM running another VMM — that reduce the exit rate of the inner VMM. Nested virtualization is increasingly important in production (CI VMs, "metal" cloud instance types, KVM-in-KVM); the survey's performance numbers in [§09](/virtualization/performance/) implicitly assume a single level, and per-exit costs can multiply when nesting.

The cumulative effect over a decade was to push exit rates on common workloads down by an order of magnitude relative to first-generation VT-x. The general direction is unmistakable: hardware-assisted virtualization is increasingly *not* about trap-and-emulate at all but about *trap-as-rarely-as-possible*.

## Non-x86 Architectures

The discussion above is x86-centric because the historical engineering interest in CPU virtualization is largely the story of x86. Other architectures faced different starting conditions and arrived at different solutions.

**ARM** added virtualization extensions in ARMv7-A (Cortex-A15, 2011) and refined them in ARMv8-A. The architecture introduces a new exception level **EL2** in which the hypervisor executes, with guests running at EL1 (kernel) and EL0 (user). Sensitive operations issued at EL1 can be configured to trap to EL2 via the `HCR_EL2` control register. Memory virtualization uses a **Stage-2 translation** that is the direct analogue of EPT/NPT: the guest manages its own Stage-1 tables, and the hypervisor controls Stage-2. Unlike x86, ARM's design satisfies the Popek–Goldberg condition by construction once EL2 is enabled — there are no sensitive-but-non-privileged instructions to work around — so the architecture never required a binary-translation phase. KVM/ARM is the dominant production hypervisor on this stack.

**RISC-V** added a **Hypervisor extension (H-extension)** ratified in 2021. Like ARM, it provides explicit hypervisor mode (HS-mode) and a two-stage translation (G-stage); like ARM, it satisfies Popek–Goldberg natively. The extension is significantly newer than the ARM and x86 equivalents and the production ecosystem is correspondingly less mature, but the design is straightforward to reason about and several research hypervisors target it.

The lesson across the three architectures is that *the x86 virtualization gap was an accident of x86's history, not a fundamental property of computing*. Architectures designed (or extended) with virtualization in mind from the start avoid the entire binary-translation/paravirtualization detour.

## vCPU Scheduling

Hardware extensions and software techniques determine *what happens when* a vCPU executes a sensitive operation. A separate concern is *which* vCPU executes on *which* physical CPU at any given time, and *for how long*. This is the **vCPU scheduling** problem.

### Time-multiplexing

In the simplest case, a VMM schedules vCPUs onto pCPUs the way an OS schedules threads onto CPUs. Each vCPU is a runnable entity; the scheduler picks one to run on each pCPU at each scheduling decision. The decision points are familiar: timer tick, vCPU yield (typically via a `HLT` instruction or a paravirtual yield hypercall), VM-exit that blocks (waiting for I/O, for a lock).

A VMM scheduler must answer the same questions a thread scheduler does — fairness, priority, preemption — but with two complications.

### Multi-vCPU guests and gang scheduling

When a guest has multiple vCPUs, the guest's own OS makes assumptions about their concurrency: in particular, that a vCPU holding a spinlock will eventually release it, that another vCPU spinning on the lock will see the release promptly, and that all vCPUs make progress together. A VMM that schedules vCPUs independently breaks these assumptions:

- **Lock-holder preemption.** If the VMM preempts a vCPU while it holds a guest spinlock, other vCPUs spinning on that lock waste CPU until the holder is rescheduled. A guest workload built around fine-grained spinlocks can collapse in performance.
- **Synchronization latency.** IPIs (inter-processor interrupts) between vCPUs must be delivered to the target vCPU promptly, which requires either that the target is currently running or that the IPI causes it to be scheduled.

Two responses are common. **Co-scheduling** (or **gang scheduling**) tries to schedule a guest's vCPUs together — all running, or all paused. This avoids lock-holder preemption but constrains the scheduler and can leave pCPUs idle. **Paravirtual lock primitives** let the guest tell the VMM that a vCPU is spinning so the VMM can yield it to the lock holder; modern Linux on KVM supports this via `pvspinlock` interfaces. Most production hypervisors use a mixture.

### NUMA and CPU pinning

On NUMA hardware, a vCPU's memory accesses are fast or slow depending on whether the backing memory is local to the pCPU it runs on. Hypervisors expose policies — vCPU pinning, NUMA-aware memory allocation, vNUMA topology presented to the guest — that let an operator align virtual and physical layouts. The defaults rarely produce optimal results for performance-sensitive guests; explicit configuration is the norm in production.

### Overcommit

A hypervisor may present more vCPUs than it has pCPUs to back. **CPU overcommit** trades latency (a vCPU may have to wait for a pCPU) for density (more guests per host). The economics drive most cloud and consolidation workloads to some degree of overcommit; the exact ratio depends on the workload's tolerance for jitter.

## What this section established

A VMM virtualizes a CPU by some combination of three techniques: classical trap-and-emulate (where the architecture permits it), software workarounds for non-virtualizable architectures (binary translation, paravirtualization), and hardware-assisted virtualization (VT-x / AMD-V). The dominant technique today is hardware-assisted, with paravirtual interfaces retained where they outperform full virtualization (notably in I/O). The dominant performance concern in any of these regimes is **exit cost** — and the entire trajectory of CPU virtualization since 2005 has been to reduce the number and cost of exits.

Cutting across the technique question is the **scheduling** problem: the VMM must decide which vCPU runs where and for how long, with extra care for multi-vCPU guests that assume the concurrency of bare hardware.

The next section, [Memory Virtualization](/virtualization/memory/), takes up the second component of the VMM and examines how guest-physical memory is mapped to host-physical memory — and how the answer changed when the EPT / NPT extensions arrived.
