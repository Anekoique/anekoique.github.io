---
date: '2026-05-17T20:00:00+08:00'
draft: false
title: 'Virtualization Systems — Xen'
slug: 'xen'
tags: ["Virtualization", "Hypervisor", "Systems", "Xen"]
series: ["Virtualization Series"]
summary: "Canonical paravirtualizing Type-1 hypervisor. PV/HVM/PVH modes contrasted side by side across CPU, memory, I/O, cross-domain communication, and VM management. The disaggregated shape in production form."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

Xen is the canonical paravirtualizing Type-1 hypervisor, first published as [*Xen and the Art of Virtualization*](https://dl.acm.org/doi/10.1145/944220.944235) (Barham et al., SOSP 2003) at the University of Cambridge Computer Laboratory and continuously developed since then by the Xen Project under the Linux Foundation. The 2003 paper introduced the architectural vocabulary the survey reuses verbatim — `dom0`, `domU`, hypercalls, event channels, I/O rings, grant tables, the split-driver model. Modern Xen (the current `xen.git` tree, 4.22-pre tip at the time of writing) accreted full hardware-assisted virtualization (`HVM`, 2005), nested paging (EPT/NPT, 2007–2008), the PVH hybrid (2014), and a much larger control surface — but the design spine is the same.

What makes Xen worth reading carefully is that it concretely demonstrates the [§03](/virtualization/vmm-architecture/) *disaggregated* shape in production form: the hypervisor is small and contains no device drivers, while a privileged guest (`dom0`) runs all device code and all control-plane logic. Every cross-domain interaction — guest↔hypervisor, guest↔dom0, guest↔guest — uses a well-designed three-mechanism stack (event channels for notification, I/O rings for transport, grant tables for authorization) that the rest of the industry, including modern virtio, descends from.

This note follows the survey's chapter order, with each chapter explicitly contrasting the three guest modes Xen supports.

## §02 — Taxonomy: Xen at a glance

| Axis | Xen |
|---|---|
| Placement | Type-1 bare-metal; runs in VMX root (Intel) / SVM host (AMD) / EL2 (ARM) / HS-mode (RISC-V) |
| Guest interface | Three coexisting modes: **PV** (paravirtualized, ported guest), **HVM** (fully virtualized, unmodified guest with virtual firmware), **PVH** (PV-style boot + HVM-style runtime — the modern default) |
| Hardware support | Originally none required (PV closed the x86 virtualizability gap by changing the guest); modern Xen depends on VT-x/SVM + EPT/NPT for HVM/PVH, optionally IOMMU (VT-d/AMD-Vi) for passthrough |
| Isolation boundary | Hardware (per-domain page tables + ring deprivileging for PV / VMX non-root for HVM/PVH); internally *disaggregated* — driver code lives in `dom0` / driver domains, not in the hypervisor |

The defining structural choice is **dom0 as a privileged Linux guest that owns all device drivers and the control plane**. The hypervisor proper (`xen/` in the tree) contains no PCI drivers, no filesystem, no network stack; it boots, builds `dom0`, then hands off everything else.

## Modes at a glance, before the details

Every claim below is mode-specific. The summary table:

| | **PV** (2003) | **HVM** (2005) | **PVH** (2014) |
|---|---|---|---|
| Designed for | Cooperating Linux/BSD ports | Unmodified guests (Windows, off-the-shelf Linux) | Cooperating guests with hardware-assisted runtime |
| Guest CPU mode | Ring 1 (x86-32) / Ring 3 + separate PT (x86-64) — deprivileged | VMX non-root | VMX non-root |
| Hardware required | None — invented to avoid VT-x | VT-x / AMD-V (+ EPT/NPT strongly preferred) | VT-x / AMD-V + EPT/NPT (mandatory) |
| Guest modification | Substantial PV port | None | Small "PVH ABI" port |
| MMU model | Direct guest PTs, validated by hypercall | Shadow PTs (legacy) or EPT/NPT (modern) | EPT/NPT |
| Boot ABI | PV `start_info` page | Virtual BIOS/UEFI → bootloader → kernel | PVH `start_info` (direct kernel) |
| Legacy device emulation | None (PV split drivers only) | Yes — `qemu-dm` process per domain | None |
| Modern status | Legacy; some Linux distros still | Universal for Windows and unmodified guests | **Default for dom0 and Linux domU** |

Three rules to internalize:

1. **The mode is fixed at domain creation** (`xl create` reads `type=` from the config; the hypervisor records it in `struct domain.guest_type`). No runtime switch.
2. **All three modes can coexist** on one hypervisor — the typical production picture is a PVH `dom0`, several PVH Linux `domU`s, and one HVM Windows `domU`, all simultaneously.
3. **dom0 is structurally required** in all three modes — without it there is no control plane, no domain builder, no device backends. The hypervisor can boot without `dom0` only to idle forever.

## §03 — Anatomy: what's in the hypervisor, what's in dom0

The [§03](/virtualization/vmm-architecture/) vocabulary places Xen in the **disaggregated** shape. The hypervisor binary itself is small (~600 KLoC total in the tree, but only ~50–100 KLoC on the hot path); the rest of "what feels like Xen" lives in `dom0`.

```
  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
  │  dom0  (PVH Linux)  │  │  domU-1  (HVM)      │  │  domU-2  (PVH)      │
  │ ─────────────────── │  │ ─────────────────── │  │ ─────────────────── │
  │  Linux kernel       │  │  Windows kernel     │  │  Linux kernel       │
  │   • drivers (real)  │  │   • PV frontends    │  │   • PV frontends    │
  │   • netback/blkback │  │  ─────────────────  │  │  ─────────────────  │
  │  ─────────────────  │  │  Windows userspace  │  │  Linux userspace    │
  │  Linux userspace    │  │                     │  │                     │
  │   • xl / libxl      │  │                     │  │                     │
  │   • xenstored       │  │                     │  │                     │
  │   • qemu-dm[domU-1] │  │                     │  │                     │
  └──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘
             │                        │                        │
             │ domctl HC              │ ioreq pages            │ rings +
             │                        │ (HVM device emul)      │ grants +
             │                        │                        │ event chan
             ▼                        ▼                        ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │            Xen hypervisor   (Ring −1 / VMX root / EL2)                │
  │ ───────────────────────────────────────────────────────────────────── │
  │  scheduler  │  MMU + EPT  │  event channels  │  grants  │  hypercalls │
  └───────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                              physical hardware
```

Cross-domain wires (not shown above to keep the picture clean):

- `dom0.netback/blkback`  ↔  `domU-1.PV frontends` and `domU-2.PV frontends` — rings + grants + event channels (PV split drivers)
- `dom0.qemu-dm[domU-1]`  ↔  Xen ioreq pages  ↔  `domU-1` MMIO traps (HVM device emulation; only HVM domains need this)
- `dom0.xl/libxl`  →  Xen `domctl` hypercalls — domain lifecycle (create/start/stop/destroy)

Anatomy mapping per [§03](/virtualization/vmm-architecture/):

| §03 component | Xen location |
|---|---|
| Control plane | `dom0`-side `xl`/`libxl` tools issue `domctl` hypercalls; in-hypervisor dispatch at `xen/common/domctl.c:275` |
| vCPU model | `struct vcpu` (`xen/include/xen/sched.h:179`); per-vCPU register state in arch-specific `vcpu.arch` |
| Memory model | Per-domain page tables; modern HVM/PVH uses hardware nested paging (EPT/NPT) — `xen/arch/x86/mm/p2m*.c` |
| Device model | Split across the boundary: **frontend drivers** in the guest (`netfront`, `blkfront`), **backend drivers** in `dom0` (`netback`, `blkback`); HVM legacy emulation runs in `dom0` user-space `qemu-dm` |
| Interrupt/timer | Per-domain event channels (`xen/common/event_channel.c`, 1822 LoC) — software interrupt mechanism, not a virtual APIC; HVM additionally exposes a virtual APIC |
| Exit handler | Per-arch trap entry; on x86 HVM: `xen/arch/x86/hvm/vmx/vmx.c:4176` (`vmx_vmexit_handler`) and `xen/arch/x86/hvm/hvm.c` (architecture-generic HVM logic) |

### The two big in-hypervisor data structures

Almost everything in Xen revolves around `struct domain` and `struct vcpu`. Internalize their layout and the rest of the code becomes navigable.

**`struct domain`** (`xen/include/xen/sched.h:315`, ~several hundred fields):

- **Identity**: `domain_id`, `handle` (UUID), `guest_type` (PV/HVM/PVH), creation flags
- **vCPU list**: `vcpu` array, `max_vcpus`
- **Memory state**: `tot_pages` / `max_pages`, `page_list` (every page assigned to this domain), `xenpage_list` (Xen-owned bookkeeping)
- **Paging state**: `arch.paging` substruct — shadow or HAP (hardware-assisted paging), mode-dependent
- **Event channels**: `evtchn_port_ops` (vtable for 2L or FIFO ABI), per-port arrays
- **Grants**: pointer to `struct grant_table`
- **Scheduler state**: opaque `sched_priv` (owned by active scheduler), `cpupool` pointer
- **I/O permissions**: `iomem_caps`, `ioport_caps`, `irq_caps` — bitmaps of which physical resources this domain may touch (empty except for `dom0` and driver domains)

Lifecycle: `domain_create()` at `xen/common/domain.c:873` → `domain_kill()` at line 1305 → `complete_domain_destroy()`. Two-phase destroy because other CPUs may still hold pointers across an RCU grace period.

**`struct vcpu`** (`xen/include/xen/sched.h:179`):

- **Identity**: `vcpu_id`, `processor` (current pCPU), back-pointer to `domain`
- **Runstate**: running / runnable / blocked / offline
- **Architectural state**: opaque `arch` substruct. For HVM: VMCS pointer, posted-interrupt descriptor. For PV: saved GPRs, segments, FPU, CR3 value
- **Event-channel state**: `vcpu_info` pointer (the shared-memory page with pending-event bitmap), `virq_to_evtchn` mapping
- **Scheduling state**: `sched_unit` (usually 1:1 with vCPU; Credit2 groups SMT siblings)

The key invariant: **vCPUs in a domain share the page-table root** (it lives in `domain.arch.paging`), the way threads share an address space in a process. Two vCPUs in one domain see the same memory.

---

## §04 — CPU virtualization

The CPU model is where the three modes diverge most sharply, because it's where the relationship between guest and hardware is decided.

### How the guest physically executes

| | PV | HVM | PVH |
|---|---|---|---|
| Hardware mode | Deprivileged ring | VMX non-root | VMX non-root |
| Sensitive ops | x86 exception (#GP, #NM) | VM-exit | VM-exit |
| Hot-path mediation | Replaced with hypercalls at port time | Trap-and-emulate (or pass through via VMCS controls) | Same as HVM |
| Xen entry path | `xen/arch/x86/traps.c:do_general_protection` | `xen/arch/x86/hvm/vmx/vmx.c:4176` (`vmx_vmexit_handler`) | Same as HVM |
| Per-vCPU control block | none in hardware | VMCS (Intel) / VMCB (AMD) | Same as HVM |

The PV path is "x86 exception → C handler in Xen → decode instruction → emulate against per-vCPU virtual state". The HVM/PVH path is "VM-exit → VMCS `EXIT_REASON` field → dispatch in `vmx_vmexit_handler`'s switch → emulate or fix-up → `vmresume`". Per-event cost is comparable on modern hardware; the *number* of events differs dramatically because PV guests batch operations into hypercalls, HVM/PVH guests trigger one exit per sensitive instruction unless the VMCS execution controls let it pass through.

### Trace 1: a guest changes its page-table root

The same operation (switching process address spaces) in each mode.

**PV — the cooperative path.** Linux's Xen port does not execute `mov %cr3` at all. Its `pv_mmu_ops.write_cr3` calls `HYPERVISOR_mmuext_op(MMUEXT_NEW_BASEPTR, mfn)`.

```
guest kernel (ring 3 on x86-64)
   │  HYPERVISOR_mmuext_op(NEW_BASEPTR, mfn)
   │  syscall → Xen hypercall page
   ▼
Xen do_mmuext_op (xen/arch/x86/mm.c)
   │  validate: mfn is owned by this domain
   │  validate: mfn has type PGT_l4_page_table (pinned)
   │  update vcpu.arch.guest_table, write CR3 register
   ▼
return to guest at instruction after the hypercall
```

One hypercall, no x86 exception, no shadow update. The validation is the load-bearing work — Xen confirms the guest isn't trying to install a page-table root it doesn't own.

**HVM — the hardware-assisted path.** Unmodified Linux executes `mov %eax, %cr3` directly. With EPT and no CR3-store exiting configured (the common modern case), **this does not exit at all**:

```
guest kernel (VMX non-root)
   │  mov %eax, %cr3   ← executes natively
   │  guest's view of CR3 changes
   ▼
guest continues; EPT continues translating whatever
guest-physical addresses the guest's new PTs produce
```

If CR3-store exiting *is* configured (legacy shadow path, debugging), the path is:

```
guest kernel (VMX non-root)
   │  mov %eax, %cr3
   ▼  ──── VM-exit (saves full guest state to VMCS) ────
Xen vmx_vmexit_handler (vmx.c:4176)
   │  read VMCS.EXIT_REASON  = CR_ACCESS
   │  read VMCS.EXIT_QUALIFICATION  → which CR, R/W, src reg
   │  dispatch vmx_cr_access()
   │  hvm_set_cr3(new_value)
   │   ├─ updates virtual CR3 in vcpu.arch
   │   └─ rebuilds shadow PT (if shadow mode) or no-op (if HAP/EPT)
   │  ──── VMRESUME ────
   ▼
guest resumes at instruction after the mov
```

**PVH** uses EPT and VMX exactly the way HVM does; the CR3 path is mode-agnostic between HVM and PVH. PVH always uses HAP, so the "did this exit" answer is almost always *no*.

Round-trip cost on modern hardware: a few hundred to a few thousand cycles, dominated by save/restore of architectural state across the VM-exit. The trajectory since first-gen VT-x has been to *reduce the number of exits* — modern guests on EPT + APICv + posted interrupts exit ~100× less per second than they did in 2006.

### vCPU control state, side by side

| | PV | HVM | PVH |
|---|---|---|---|
| Where guest GPRs live | `vcpu.arch.guest_context` (Xen-defined struct) | `vcpu.arch.user_regs` + auto-saved VMCS fields | Same as HVM |
| Hardware control structure | None | VMCS / VMCB, one per vCPU | Same as HVM |
| FPU state | Lazy-saved into `vcpu.arch.fpu_ctxt` | Saved by VMCS auto-save | Same as HVM |
| Initial state setup | Hypervisor reads from `XEN_DOMCTL_setvcpucontext` payload, populates `vcpu.arch.guest_context` directly | Same payload, populated into VMCS via `hvm_set_*` helpers | Same as HVM |

### Scheduling (mode-agnostic)

The scheduler doesn't care what mode a vCPU is in — same `struct vcpu` regardless. Five pluggable schedulers ship in-tree via the `struct scheduler` vtable in `xen/common/sched/private.h`:

| Scheduler | File / LoC | Use case |
|---|---|---|
| `credit` | `credit.c` / 2315 | Original SMP-aware proportional-share; legacy |
| `credit2` | `credit2.c` / 4273 | Modern default; NUMA-aware, hyperthread-aware |
| `null` | `null.c` / 1073 | Static 1:1 vCPU↔pCPU pinning |
| `arinc653` | `arinc653.c` / ~750 | ARINC 653 time-partitioned, for avionics |
| `rt` | `rt.c` / ~1500 | Real-time (deferrable server / EDF variants) |

Credit2 algorithm (design comment at `credit2.c:75`): each runnable vCPU has a weight (default 256, configurable per-domain). Credits burn as the vCPU runs at rate `1/weight`, so heavy vCPUs burn slowly. Runqueue sorted by remaining credits, highest-credit vCPU runs next. When the next vCPU's credits go ≤0, *everyone* gets a credit reset, preserving relative order.

What turns this into 4273 lines: NUMA-aware migration, hyperthread awareness, multiple per-NUMA runqueues with periodic load-balancing, wake-up "tickling" (a newly-runnable vCPU shouldn't wait for the next tick), and **CPU pools** (`xen/common/sched/cpupool.c`) — each pool has its own runqueues and its own scheduler instance, so different domains can run on different scheduling regimes on the same machine.

`null` is the interesting comparison: ~1000 LoC, holds a single mapping from vCPU to pCPU, `do_schedule` just returns "keep running who you were running". No runqueue, no credits, no balancing. The same scheduler vtable Credit2 fills with 4273 lines.

---

## §05 — Memory virtualization

The memory model is where the three modes are *most* different — three distinct mechanisms for translating guest-virtual to host-physical.

### The translation pipeline by mode

| | PV | HVM (legacy) | HVM (modern) / PVH |
|---|---|---|---|
| Guest manages its own PTs? | Yes, but every write validated by hypercall | No — Xen maintains shadows | Yes, walks them natively |
| Translation path | guest-virtual → host-physical (one walk, guest PT) | guest-virtual → host-physical (one walk, shadow PT) | guest-virtual → guest-physical (guest PT) → host-physical (EPT) |
| Hardware support needed | None | VT-x | VT-x + EPT/NPT |
| Xen intervention per guest PT write | Hypercall (validation) | Shadow PT recompute on trap | Never |
| Code location | `xen/arch/x86/mm.c` | `xen/arch/x86/mm/shadow/` | `xen/arch/x86/mm/p2m*.c` |

### PV: validated direct page tables

This is the part most worth understanding mechanically — it's unique to Xen and shows what's possible without hardware support.

**Setup**: every host-physical page has a *type*, tracked in a Xen-internal array (one entry per 4 KB page):

- `PGT_none` — ordinary data
- `PGT_writable_page` — writable mapping exists
- `PGT_l1_page_table` / `_l2_` / `_l3_` / `_l4_page_table` — used as a page table at the given level
- `PGT_seg_desc_page` — used as a GDT/LDT page

**Two invariants** Xen enforces:

1. A page typed as a page-table cannot also have writable mappings. To modify a PT page, the guest calls `mmuext_op(MMUEXT_UNPIN)` to drop its type, modifies it, calls `MMUEXT_PIN_TABLE` to re-establish.
2. Every entry installed into a PT page is validated: does the entry reference a page this domain owns? Are permissions consistent (no writable mapping to a typed PT page)?

**Guest interface**: `__HYPERVISOR_mmu_update` (hypercall #1, handler `do_mmu_update` in `xen/arch/x86/mm.c`). Guests submit batches of `(pte_address, new_value)` updates; Xen validates and applies each. Batching is essential — guests wait until they have TLB-flush-sized batches before submitting.

The validation discipline lives in `xen/arch/x86/mm.c:get_page_type()` — the function that embodies the entire mechanism. An afternoon with that function is what makes PV memory click.

**Cost profile**: zero per-translation overhead (MMU walks guest's own PT directly); per-update hypercall cost, amortized by batching. On steady-state workloads PV typically *beat* first-generation VT-x + shadow because PV avoided per-PT-write VM-exits.

**Why HVM doesn't use this**: HVM exists for unmodified guests, and an unmodified guest doesn't issue `mmu_update` hypercalls — it just does `mov %eax, (%rdi)` to write a PTE. Without paravirtualization, the writes can't be intercepted without shadow tables or hardware nested paging.

### HVM legacy: shadow page tables

When HVM landed in 2005 for first-gen VT-x without nested paging, Xen had to maintain shadow tables — the mechanism [§05](/virtualization/memory/) describes:

- Mark guest PT pages read-only in the shadow tables (the ones hardware actually walks).
- Trap guest writes to PT pages, decode the write, propagate to the shadow.
- Keep shadows coherent on every guest update.

Code in `xen/arch/x86/mm/shadow/`. High maintenance cost (per-write trap), substantial memory cost (one shadow tree per guest address space). Used today only as fallback when EPT/NPT is unavailable.

### HVM modern / PVH: nested paging (EPT/NPT)

EPT (Intel, Nehalem 2008) and NPT (AMD, Barcelona 2007) add a hardware-walked second translation layer. Xen manages a per-domain *p2m table* in `xen/arch/x86/mm/p2m*.c`. The guest manages its own first-stage PTs natively; the MMU walks both stages.

```
guest-virtual addr
       │
       │  guest's own page table  ← guest writes freely, no exit
       ▼
guest-physical addr
       │
       │  EPT / NPT  ← Xen-managed, hardware-walked
       ▼
host-physical addr
```

The transformative consequence: **the guest can manage its own page tables without Xen ever intervening**. Guest PT writes, `mov %eax, %cr3`, `invlpg` — all execute natively. Xen is involved only when the second-stage mapping itself must change (memory hotplug, ballooning, dirty tracking for migration).

**Cost profile**: longer page-table walks (composed two-stage; worst case ~24 memory accesses for 4-level paging on a TLB miss), TLB pressure higher; mitigated by paging-structure caches and 2M/1G huge pages on the second stage.

### Memory allocation and overcommit

Across all three modes, memory is statically partitioned at domain creation by default. The 2003 paper §3.3.4: *"The initial memory allocation, or reservation, for each domain is specified at the time of its creation; memory is thus statically partitioned between domains, providing strong isolation."*

The allocation hypercall is `XENMEM_populate_physmap` (sub-op of `__HYPERVISOR_memory_op` #12, handler at `xen/common/memory.c:1561`): caller specifies how many pages to allocate and where to map them in the target domain's guest-physical space.

Overcommit mechanisms by mode:

| Mechanism | PV | HVM | PVH | Notes |
|---|---|---|---|---|
| Ballooning | ✓ | ✓ (via PV drivers in guest) | ✓ | Dominant production mechanism in all modes |
| Maximum-allowable reservation | ✓ | ✓ | ✓ | `tot_pages < max_pages` at creation |
| Demand allocation via p2m fault | n/a | ✓ via EPT fault | ✓ via EPT fault | Requires a hardware-walked second stage |
| Tmem (transcendent memory) | (historical) | (historical) | (historical) | Dropped in modern versions |
| Live-migration dirty tracking | log-dirty on shadow | log-dirty on shadow or EPT | log-dirty on EPT | Same machinery as for migration |
| Content-based page sharing | Not in-tree | Not in-tree | Not in-tree | Security concerns kept it out |

### IOMMU integration (mode-agnostic)

For DMA confinement on pass-through, Xen integrates VT-d / AMD-Vi. Each domain has an IOMMU page table mirroring its CPU-visible memory map. Code in `xen/drivers/passthrough/{vtd,amd}/`. The IOMMU sees guest-physical addresses and translates them to host-physical using its own per-domain table, regardless of how the CPU-side translation is implemented.

---

## §06 — I/O virtualization

Xen's I/O architecture is the cleanest example of the [§03](/virtualization/vmm-architecture/) disaggregated shape: **the hypervisor contains no device drivers**. All device work happens in `dom0` (or in a dedicated driver domain), and `domU` guests reach devices through the [§07](/virtualization/communication/) mechanism set.

### I/O approach availability by mode

| Approach | PV | HVM | PVH |
|---|---|---|---|
| Split drivers (frontend ↔ dom0 backend) | ✓ (only option) | ✓ (with Xen-aware PV drivers in guest) | ✓ (default) |
| Full device emulation via `qemu-dm` | ✗ | ✓ | ✗ (deliberately omitted) |
| Direct device assignment + IOMMU | ✓ (with caveats) | ✓ | ✓ |

The asymmetry is intentional. PVH was created as "HVM without qemu-dm". Unmodified Windows needs HVM because it needs emulated legacy devices; cooperating Linux needs none of that and runs as PVH with a much smaller TCB.

### Approach 1: split drivers — the original Xen I/O design

A `domU` runs *frontend* drivers (`xen-netfront`, `xen-blkfront`); `dom0` runs *backend* drivers (`xen-netback`, `xen-blkback`). They communicate via the [§07](/virtualization/communication/) mechanisms (event channels + I/O rings + grant tables). The hypervisor itself never touches the data path.

Available in all three modes. In PV/PVH the guest natively uses Xen-PV frontend drivers. In HVM the guest installs Xen PV drivers (Linux's are upstream; Windows ships them separately) and they take over from emulated devices for the fast path.

End-to-end trace below in §07.

### Approach 2: HVM device emulation via `qemu-dm`

**HVM-only.** When the design committed to running unmodified guests in 2005, those guests expected to see a virtual BIOS, a virtual PCI bus, an emulated IDE controller, an emulated Realtek NIC. Xen's solution: each HVM `domU` gets a dedicated `qemu-dm` process in `dom0` user-space.

The flow on a guest MMIO access to an emulated device region:

```
guest (HVM, VMX non-root)
   │  mov %eax, (mmio_addr)   ← writes to a device register
   ▼  ──── EPT fault (region unmapped at stage 2) → VM-exit ────
Xen vmx_vmexit_handler
   │  exit reason: EPT_VIOLATION
   │  resolve mmio_addr to an ioreq server
   │  write request {addr, size, value, dir} into shared ioreq page
   │  block vCPU
   ▼  ──── signal qemu-dm via event channel ────
qemu-dm process (in dom0 user-space)
   │  wakes on event, reads ioreq page
   │  emulates device behavior (updates virtual NIC reg, queues packet, …)
   │  writes result back to ioreq page
   ▼  ──── signal Xen via event channel ────
Xen
   │  unblock vCPU, restore registers (write result into guest %eax for reads)
   │  ──── VMRESUME ────
   ▼
guest resumes
```

ioreq mechanism lives in `xen/common/ioreq.c` (Xen side) and `tools/qemu-xen/hw/xen/xen-hvm.c` (QEMU side). It's structurally identical to KVM+QEMU ([§03](/virtualization/vmm-architecture/)'s "hosted" shape) — the difference being that the QEMU process lives in a guest (`dom0`) rather than on a host kernel.

This is where most of the "why does Xen need `dom0` so much" TCB pressure comes from: `qemu-dm` is QEMU, and QEMU is over a million lines of C.

PV and PVH don't go through this path because they have no emulated devices to begin with.

### Approach 3: direct device assignment with IOMMU

Assign a physical device to one domain. The domain's driver programs real registers; device DMAs into the domain's memory directly; interrupts route to the domain's vCPU via IOMMU interrupt remapping.

Available in all three modes, with mode-specific complications:

| | PV | HVM | PVH |
|---|---|---|---|
| Pass through PCI devices | ✓ (`pciback` in dom0, `pcifront` in domU) | ✓ (VFIO-style, direct) | ✓ |
| MMIO BAR mapping | Granted or directly mapped | Direct in EPT | Direct in EPT |
| Interrupt delivery | Via event channel (PIRQ) | Posted interrupts (if supported) | Posted interrupts |
| SR-IOV virtual functions | ✓ | ✓ | ✓ |

In production a typical HVM `domU` runs with: Xen PV split-driver network and block (fast path), emulated VGA via `qemu-dm` (boot and debug), possibly an SR-IOV NIC VF (latency-sensitive). PVH `domU`s skip the qemu-dm piece but otherwise look identical.

---

## §07 — Cross-domain communication

This is the part of Xen the survey [§07](/virtualization/communication/) was largely written *about*, and the part most independent of mode — the three mechanisms (event channels, grant tables, I/O rings) work identically across PV/HVM/PVH. What differs is how the guest *invokes* them.

### Hypercall entry by mode

| | PV | HVM | PVH |
|---|---|---|---|
| Hypercall instruction | `int 0x82` (x86-32) / `syscall` to Xen hypercall page (x86-64) | `vmcall` (Intel) / `vmmcall` (AMD) | `vmcall` / `vmmcall` |
| Mode transition | x86 exception / syscall | VM-exit | VM-exit |
| Argument passing | Registers, conventional | Registers, conventional | Registers, conventional |
| Hypercall numbers | Same `__HYPERVISOR_*` table | Same | Same |

Once inside Xen, all hypercalls dispatch through the same `do_*` handlers regardless of mode. The mechanism differences are at the entry boundary, not the semantics.

### Hypercall surface (~40 entries, hot path is a handful)

Defined in `xen/include/public/xen.h`. The most architecturally important:

| # | Name | Purpose |
|---|---|---|
| 1 | `mmu_update` | Batched page-table updates with validation (PV) |
| 12 | `memory_op` | `XENMEM_*` — reservation, ballooning, populate-on-demand |
| 20 | `grant_table_op` | `GNTTABOP_*` — inter-domain page grants |
| 24 | `vcpu_op` | vCPU lifecycle (online/offline, register hooks) |
| 26 | `mmuext_op` | Extended MMU ops (TLB flush, page-type pin/unpin) |
| 29 | `sched_op` | Yield, block, shutdown, poll |
| 32 | `event_channel_op` | `EVTCHNOP_*` — event channel management |
| 33 | `physdev_op` | Physical device ops (driver domains / dom0 only) |
| 34 | `hvm_op` | HVM-specific ops (set/get param, inject interrupt) |
| 36 | `domctl` | Domain create/start/stop/destroy — `dom0` only |

Hot-path hypercalls in steady state: `event_channel_op_send`, `grant_table_op`, `sched_op_block`, and (for PV only) `mmu_update`. Everything else is control plane.

### Event channels — asynchronous notification

A per-domain bitmap of pending-event bits with edge-triggered semantics. Code at `xen/common/event_channel.c` (1822 LoC). `struct evtchn` is allocated lazily into per-domain bucket arrays (two-level scheme).

The op set (`do_event_channel_op` at line 1354):

- `EVTCHNOP_alloc_unbound` — domain allocates an unbound port willing to be bound by a peer
- `EVTCHNOP_bind_interdomain` — bind to a remote domain's unbound port (mutual rendezvous)
- `EVTCHNOP_bind_virq` — bind to a virtual IRQ (timer, debug, console)
- `EVTCHNOP_bind_ipi` — bind to an inter-vCPU IPI within the same domain
- `EVTCHNOP_bind_pirq` — bind to a real hardware IRQ (driver domains only)
- `EVTCHNOP_send` — fire an edge on a port (waking the peer)
- `EVTCHNOP_unmask` — re-enable a port after handling
- `EVTCHNOP_init_control`, `expand_array` — FIFO event-channel ABI v2

Event channels carry only *notification*, not data. They are how `dom0`'s backend tells a `domU`'s frontend "your I/O completed", and how Xen tells the guest "a virq fired".

### I/O rings — shared-memory transport

A circular queue of descriptors in a page shared between two domains. Four pointers control synchronization:

```
                  shared ring (mapped into both)
       ┌─────────────────────────────────────────────────┐
       │ desc 0 │ desc 1 │ desc 2 │ ... │ desc N         │
       └────────┴────────┴────────┴─────┴────────────────┘
            ▲                                ▲
       req_prod                          req_cons
   (producer writes,                 (consumer reads,
    shared)                            private to consumer)

       ▼                                ▼
       ... responses come back in the second half:
       rsp_prod (backend writes)        rsp_cons (frontend reads)
```

Only one side writes each index, so consumer/producer synchronization is lock-free. Templated by message type via macros in `xen/include/public/io/ring.h`; concrete formats in `io/netif.h` (network), `io/blkif.h` (block), `io/console.h`, etc.

**virtio's virtqueue is the direct lineal descendant** of this design. If you understand Xen's I/O rings you understand virtqueues, and vice versa.

### Grant tables — memory sharing with authorization

The mechanism that ties rings to bulk data transfer. Code at `xen/common/grant_table.c` (4412 LoC, the largest file in `xen/common/`).

A *grant* is a domain's authorization for another *specific* domain to access *specific* pages with *specific* permissions, published into a per-domain grant table. The op set (`do_grant_table_op` at line 3639):

- `GNTTABOP_map_grant_ref` — recipient maps a granted page into its address space
- `GNTTABOP_unmap_grant_ref` — recipient releases the mapping
- `GNTTABOP_unmap_and_replace` — atomic unmap-and-substitute (page flipping)
- `GNTTABOP_setup_table`, `set_version`, `get_version`, `query_size` — table management
- `GNTTABOP_transfer` — *give* a page to another domain (ownership transfer)
- `GNTTABOP_copy` — hypervisor-mediated copy between two granted pages (avoids mapping)
- `GNTTABOP_cache_flush` — flush hypervisor cache state

Properties grants provide: **revocation** (granter can withdraw), **fine-grained authorization** (each grant names a specific recipient), **delegation control** (grant can disallow re-granting). Essential when the parties don't fully trust each other — exactly the setting of a disaggregated VMM where backend and `domU` share buffers but don't trust each other's correctness.

`GNTTABOP_copy` is worth flagging: instead of granting access for the recipient to *map*, the granter says "the hypervisor may copy from this page to that page", and the data movement happens entirely under hypervisor control. Used heavily on the network receive path where map/unmap-per-packet cost exceeds copy cost.

### The three mechanisms composed: trace 2, a disk read end to end

The clearest demonstration of how the §07 mechanism set actually works. Works identically in PV / HVM-with-PV-drivers / PVH.

**Setup once, at domain start** (executed by `xen-blkfront` in `domU` and `xen-blkback` in `dom0`):

```
domU xen-blkfront                              dom0 xen-blkback
─────────────────                              ───────────────
1. allocate ring page in domU memory
2. GNTTABOP grant access to ring → ref_R
3. EVTCHNOP_alloc_unbound → port_E
4. xenstore: write {ref_R, port_E}
                                   ◀──── xenstore watch fires
                                       5. read {ref_R, port_E}
                                       6. GNTTABOP_map_grant_ref(ref_R)
                                          → ring page mapped into dom0
                                       7. EVTCHNOP_bind_interdomain(port_E)
                                       8. xenstore: state = Connected
```

**Per read operation**:

```
domU xen-blkfront                              dom0 xen-blkback                              physical disk
─────────────────                              ───────────────                              ─────────────
1. read() arrives at frontend
2. alloc data-buffer page
3. GNTTABOP grant access → ref_D
4. write req desc {READ, sector, ref_D, len, id}
   to ring; bump req_prod
5. EVTCHNOP_send(port_E)
   ─────────────────────────▶ Xen sets pending bit on
                              dom0's vcpu_info page
                                              6. dom0 vCPU sees event,
                                                 runs callback
                                              7. backend worker wakes,
                                                 reads req from ring
                                              8. GNTTABOP_map_grant_ref(ref_D)
                                                 → data page mapped into dom0
                                              9. issue real I/O via Linux blk layer
                                                                          ────────────▶ DMA into
                                                                                       granted page
                                                                          ◀──────────── completion irq
                                             10. write rsp desc to ring,
                                                 bump rsp_prod
                                             11. GNTTABOP_unmap_grant_ref(ref_D)
                                             12. EVTCHNOP_send(port_E)
                              ◀──────────── Xen sets pending bit on
                                            domU's vcpu_info page
13. domU vCPU sees event,
    runs callback
14. read rsp from ring
15. read() returns to userspace
```

**Cost summary**: 2 hypercalls (one send each direction), 2 grant operations, potentially zero copies (DMA into granted page), one scheduler hop each direction. The ring carried the data transfer; the event channel carried notification; the grant table provided authorization. Three mechanisms composing into exactly the right primitive for "domain A asks domain B to do work on a buffer".

In practice it's faster than this description suggests: frontends pre-grant a pool of pages and reuse them across many requests (amortizing grant cost); backends batch (one event drains all pending requests); notification suppression skips `EVTCHNOP_send` when both sides know the other is already polling.

---

## §08 — VM management

Mostly mode-agnostic at the hypercall level (`domctl` semantics are uniform), but domain *construction* differs substantially because each mode has its own boot-state setup.

### xenstore — the system-wide config database

A hierarchical key-value store accessible to every domain. The hypervisor itself doesn't implement it — `xenstored` is a daemon in `dom0` user-space. Domains talk to it via a shared page + event channel (the typical Xen pattern). It's literally an in-memory tree of strings with permissions per node.

What it's used for:

- **Service discovery**: "where's my virtual block device backend?" → `/local/domain/<id>/device/vbd/.../backend`
- **Frontend/backend handshake**: both sides watch a common path, write their state (`Initialising`, `InitWait`, `Initialised`, `Connected`, `Closing`), wait for the other to advance
- **Per-VM metadata**: name, UUID, vCPU count, memory size — browsable as `xenstore` keys
- **Live config changes**: `xl mem-set domain new-size` writes to xenstore; the in-guest balloon driver watches the key and reacts

Why it exists: `dom0` and the hypervisor need a *uniform* way to expose configuration to guests that doesn't require a hypercall ABI extension for every new piece of config. `xenstore` is the configuration ABI between `dom0` userspace and `domU` kernels. You won't see it in the hypervisor source — it's purely a `dom0`-userspace mechanism — but `xenstore-ls` in any Xen guest dumps the tree.

### Boot, then dom0

Two-phase. Phase 1 is the hypervisor coming up; phase 2 is dom0 coming up; phase 3 (every subsequent domain) is dom0 creating domUs.

```
Phase 1 — hypervisor brings up
   GRUB loads xen.gz + dom0 kernel + initrd (multiboot)
        │
        ▼
   xen/arch/x86/setup.c:__start_xen (line 1134)
        ├ relocate, switch to 64-bit
        ├ map Xen at top 64 MB of every address space
        ├ ACPI parse, SMP bring-up, NUMA discovery
        ├ scheduler init, event-channel init, grant init
        ├ IOMMU init
        ▼
Phase 2 — hypervisor builds dom0
   xen/arch/x86/dom0_build.c:construct_dom0 (line 630)
        ├ allocate struct domain for id 0; mark as control + hardware
        ├ allocate vCPUs (default: all pCPUs)
        ├ allocate memory (default: all remaining host RAM)
        ├ build address space per dom0 mode (PV / PVH)
        ├ load dom0 kernel image from multiboot module
        ├ set vCPU 0 initial regs:  %rip = entry, %rsi = start_info
        ▼
   dom0 (Linux) boots
        ├ detects Xen, takes PV/PVH boot path
        ├ initializes drivers, filesystems, init/systemd
        ├ loads xenstored, xenconsoled
        └ loads xen-netback, xen-blkback (backend kernel modules)
        │
        ▼
Phase 3 — dom0 creates domUs (per `xl create`)
   xl reads config; parses TOML/Python-config
        │
        ▼
   libxl in dom0 user-space:
        1. xc_domain_create → XEN_DOMCTL_createdomain
                              hypervisor allocates empty struct domain
        2. XENMEM_populate_physmap → allocate guest memory
        3. map domU memory into dom0 via /proc/xen/privcmd
        4. read kernel image off disk; parse via xg_dom_*loader.c
        5. write image into mapped memory
        6. (HVM only) spawn qemu-dm process for device emulation
        7. set up start-info / virtual firmware per mode
        8. XEN_DOMCTL_setvcpucontext → install initial register state
        9. XEN_DOMCTL_unpausedomain → hypervisor adds vCPUs to runqueue
        ▼
   domU boots, frontend drivers connect to dom0 backends via §07 mechanisms
```

The trade-off this captures: the hypervisor stays small (no kernel-image loader, no ELF parser, no disk I/O), and domain-building extends to new boot protocols (raw, ELF, bzImage, ARM zImage, PVH, multiboot) by adding loaders in user-space `libxl`. The cost is that `libxl` is itself substantial code running with privilege to create any domain.

### Domain construction by mode

| Step | PV | HVM | PVH |
|---|---|---|---|
| Mode flags on createdomain | (no special flag) | `CDF_hvm` + `CDF_hap` | `CDF_hvm` + `CDF_hap` |
| Image loading | PV-bootloader (`pygrub`) / ELF with PV notes | Place in low memory; SeaBIOS/OVMF firmware separately | Place at PVH-spec address |
| Address-space setup | Build PV page tables in guest memory directly | Set up EPT mapping (empty, fills on demand) | Set up EPT mapping |
| Boot info | PV `start_info` page (memory map, console MFN, store MFN, initrd, cmdline) | Virtual BIOS handles it from VMCS state | PVH `hvm_start_info` struct |
| Initial register state | `%rip` = kernel entry, page-table root pointer, etc. | `%rip` = firmware entry, %cr0/cr3/cr4 = initial | `%rip` = kernel entry, `%rsi` = start_info |
| qemu-dm | n/a | One process forked, registers as ioreq server | n/a |

**HVM construction is most complex** (extra qemu-dm + firmware setup), **PVH is simplest** (direct kernel boot, no firmware, no qemu-dm), **PV is in between** (direct kernel boot but the PV-port boot ABI is involved).

### What dom0 itself runs as

| Era | dom0 mode |
|---|---|
| 2003–2013 | Always PV (Xen had no other option for dom0) |
| 2013–2018 | PV default, HVM optional |
| 2018–present | **PVH default** (`dom0=pvh` on Xen command line), PV available for compatibility |

The modern `dom0=pvh` boot setting is what most production deployments use today. dom0 itself is also a domain that goes through the construction flow above — except that for dom0, the *hypervisor* runs the construction (`construct_dom0`), because there's no `libxl` yet.

### Management hypercall surface

`__HYPERVISOR_domctl` (#36, dispatch at `xen/common/domctl.c:275`, 901 LoC total) is the lifecycle entry point. The op codes (`XEN_DOMCTL_createdomain`, `pausedomain`, `unpausedomain`, `destroydomain`, `max_vcpus`, `setvcpuaffinity`, `scheduler_op`, `getdomaininfo`, `setvcpucontext`, ...) cover every action a control-plane tool needs.

`__HYPERVISOR_sysctl` (#35) is the partner for *system-wide* operations (querying physinfo, listing all domains, cpupool management).

Access control: `do_domctl` checks `is_control_domain(d)` — only `dom0` (or a domain with the matching XSM privilege) may invoke. This is the privileged-control-domain enforcement point.

All mode-agnostic — `domctl` semantics are the same for PV / HVM / PVH targets.

### Live migration

[§08](/virtualization/vm-management/)'s pre-copy live migration discussion is essentially [Live Migration of Virtual Machines](https://www.usenix.org/conference/nsdi-05/live-migration-virtual-machines) (Clark et al., NSDI 2005), describing live migration in Xen. The mechanism still lives in `tools/libs/guest/` (the save/restore library) and on the hypervisor side in the log-dirty page-table machinery in `xen/arch/x86/mm/`.

```
source host                                           destination host
───────────                                           ────────────────
1. xl migrate connects to destination's xl
                                ◀──────── handshake ─────────▶
2. enable log-dirty mode on migrating domain's
   second-stage PT (every guest write sets a dirty bit)
3. read all memory pages, stream to destination
                                ──── memory pages ────▶ allocate, populate
4. query dirty bitmap; re-send dirty pages
                                ──── dirty pages ─────▶
   repeat until dirty rate falls below threshold
5. pause domain
6. send residual dirty pages + vCPU state + device state
                                ──── final delta ─────▶
                                                       7. restore vCPU state,
                                                          unpause → domain resumes
8. destroy paused domain on source
```

Mode-specific complications:

| | PV | HVM | PVH |
|---|---|---|---|
| Memory dirty tracking | log-dirty on shadow | log-dirty on shadow or EPT | log-dirty on EPT |
| vCPU state save | `vcpu.arch.guest_context` | VMCS state + HVM context | VMCS state + HVM context |
| Device state save | Frontend state via xenstore | qemu-dm device state + frontend state | Frontend state only |
| Special complications | None | qemu-dm state must serialize; some emulated devices can't migrate cleanly | None |
| Migration difficulty | Medium | Hard | Easy |

**PVH is easiest to live-migrate**, HVM is hardest (qemu-dm state is the problem child), PV is in between.

Convergence corner cases match the [§08](/virtualization/vm-management/) discussion: dirty rate exceeding copy rate (Xen rate-limits the guest's CPU), pass-through device state (no good story; this is why migratable guests prefer virtio over pass-through), network attachment (destination must be on same L2 segment or use overlay networking).

### Nested virtualization

Xen can run as a guest on another hypervisor, and Xen can host another hypervisor as a guest. Both directions work; the hairy case is the latter.

**Xen as L0 hosting L1 hypervisor**: L1 (HVM mode) issues VMX instructions (`VMREAD`, `VMWRITE`, `VMLAUNCH`, `VMRESUME`); L0 intercepts and emulates, maintaining a shadow VMCS that represents the composed L0+L1 controls. When an L2 guest exits, hardware exits to L0; L0 decides whether L0 itself handles it or forwards to L1. Code in `xen/arch/x86/hvm/nestedhvm.c` and `xen/arch/x86/hvm/vmx/vvmx.c`.

Cost is substantial — every L2 exit potentially costs two L0 exits plus L1's handler. Intel added **VMCS Shadowing** (Haswell, 2013) to make some L1 VMREAD/VMWRITE skip the L0 exit. Matters in production for cloud-in-cloud (AWS metal instances, CI inside VMs inside containers).

### ARM and RISC-V — what changes

Xen has a mature ARM port (`xen/arch/arm/`) and an in-progress RISC-V port (`xen/arch/riscv/`). Reading them clarifies what's *architectural* versus what's *x86 quirk*.

**ARM**:

- Runs at **EL2** — the dedicated hypervisor exception level. No "ring -1" hack; the architecture was designed with virtualization in place from the start, satisfying Popek-Goldberg by construction.
- **Stage-2 translation** is the direct equivalent of EPT/NPT.
- **No PV mode** — there's no virtualizability gap to paravirtualize around. ARM port supports HVM-equivalent and PVH-equivalent only.
- **GIC virtualization**: hardware support for guest interrupt delivery (GICv2 VIRT, GICv3+).
- **PSCI**: ARM's standardized power-management hypercall interface used both for real power management and as the guest's CPU-on/off interface.

**RISC-V** (newer, started ~2022): mirrors ARM, uses H-extension's HS-mode (equivalent of EL2) and G-stage paging (equivalent of Stage-2/EPT).

**The implication for reading the codebase**: many things that look like "Xen architecture" in `xen/common/` are actually "Xen-x86 quirks" exported to common code. The ARM port had to clean up some abstractions; reading `xen/arch/arm/` after `xen/arch/x86/` clarifies which parts of the design are essential and which are historical.

---

## Mode×chapter matrix

The entire design space in one table, for reference:

| Topic | PV | HVM | PVH |
|---|---|---|---|
| **§04 guest exec mode** | Deprivileged ring, x86 exceptions | VMX non-root, VM-exits | VMX non-root, VM-exits |
| **§04 sensitive-op handling** | Hypercalls (designed in) | Emulate on exit | Emulate on exit |
| **§04 hardware needed** | None | VT-x/AMD-V | VT-x/AMD-V + EPT/NPT |
| **§05 memory translation** | Direct PT, hypercall-validated | Shadow PT or EPT/NPT | EPT/NPT only |
| **§05 page tables managed by** | Guest, validated per update | Xen (shadow) or guest (EPT) | Guest natively |
| **§06 emulated devices** | None | Yes (qemu-dm) | None |
| **§06 PV split drivers** | Yes (only option) | Yes (with PV drivers in guest) | Yes (default) |
| **§06 device passthrough** | Yes | Yes | Yes |
| **§07 hypercall instruction** | `int 0x82` / syscall | `vmcall` / `vmmcall` | `vmcall` / `vmmcall` |
| **§07 event channels** | ✓ | ✓ | ✓ |
| **§07 grant tables** | ✓ | ✓ | ✓ |
| **§07 I/O rings** | ✓ | ✓ (via PV drivers) | ✓ |
| **§08 construction complexity** | Medium (PV bootloader, PT setup) | High (firmware + qemu-dm) | Low (direct kernel) |
| **§08 dom0 default today** | Legacy | n/a | Modern default |
| **§08 live-migration difficulty** | Medium | Hard (qemu-dm state) | Easy |
| **TCB inclusion in dom0** | Linux kernel | Linux kernel + qemu-dm | Linux kernel |

One-sentence summaries of the three modes:

- **PV** — guest is ported to call Xen via hypercalls; no hardware support needed; per-event cost low but guest must be ported.
- **HVM** — unmodified guest sees real-looking hardware via VT-x + per-VM qemu-dm; broadest compatibility, largest TCB.
- **PVH** — cooperating guest uses VT-x for execution but skips firmware and qemu-dm; modern default, smallest TCB among the three.

Trajectory: **PV was Xen's answer to "x86 isn't virtualizable", HVM was the answer to "we need to run Windows", PVH is the modern synthesis that takes hardware support for granted and discards the legacy compatibility tax.**

## Source map

For navigation when reading the tree:

```text
xen/                                       — the hypervisor binary
├── common/
│   ├── domain.c           (2557 LoC)      — domain_create at line 873, domain_kill at 1305
│   ├── domctl.c            (901 LoC)      — do_domctl at 275: control-plane HC dispatch
│   ├── event_channel.c    (1822 LoC)      — do_event_channel_op at 1354
│   ├── grant_table.c      (4412 LoC)      — do_grant_table_op at 3639
│   ├── memory.c                           — XENMEM_populate_physmap at 1561
│   ├── ioreq.c                            — HVM device-emulation routing
│   └── sched/
│       ├── core.c                         — scheduler-pluggable framework
│       ├── credit.c       (2315 LoC)      — original credit scheduler
│       ├── credit2.c      (4273 LoC)      — modern default (design comment at 75)
│       ├── null.c         (1073 LoC)      — static pinning
│       ├── arinc653.c                     — ARINC 653 time-partitioned
│       ├── rt.c                           — real-time
│       └── cpupool.c                      — pCPU pools with per-pool sched
├── arch/
│   ├── x86/
│   │   ├── setup.c                        — __start_xen at 1134; construct_dom0 call at 1122
│   │   ├── dom0_build.c                   — construct_dom0 at 630
│   │   ├── traps.c                        — PV exception entry, do_general_protection
│   │   ├── mm.c           (6572 LoC)      — PV memory: do_mmu_update at 3984, get_page_type
│   │   ├── mm/
│   │   │   ├── shadow/                    — shadow page tables (legacy HVM)
│   │   │   └── p2m*.c                     — second-stage (EPT/NPT) maps
│   │   └── hvm/
│   │       ├── hvm.c      (5463 LoC)      — arch-generic HVM logic
│   │       ├── vmx/vmx.c  (5043 LoC)      — Intel VMX path; vmx_vmexit_handler at 4176
│   │       └── svm/svm.c                  — AMD SVM path
│   ├── arm/                               — ARM port (EL2)
│   ├── riscv/                             — RISC-V port (H-extension)
│   └── ppc/                               — PowerPC port
└── include/
    ├── xen/sched.h                        — struct vcpu at 179, struct domain at 315
    └── public/                            — hypercall ABI (consumed by guests/tools)
        ├── xen.h                          — __HYPERVISOR_* numbers
        ├── event_channel.h                — EVTCHNOP_*
        ├── grant_table.h                  — GNTTABOP_*
        ├── memory.h                       — XENMEM_*
        ├── domctl.h                       — XEN_DOMCTL_*
        └── io/                            — I/O ring message formats
            ├── ring.h                     — ring macros
            ├── netif.h                    — netfront/netback messages
            └── blkif.h                    — blkfront/blkback messages

tools/                                     — dom0 user-space (not in hypervisor TCB)
├── libs/light/                            — libxl: high-level domain management
├── libs/guest/                            — libxg: low-level loading and save/restore
│   ├── xg_dom_*loader.c                   — boot-protocol-specific image loaders
│   └── xg_sr_*.c                          — save/restore for live migration
├── libs/ctrl/                             — libxc: hypercall wrappers
├── xl/                                    — the xl CLI
└── qemu-xen/                              — fork of QEMU as Xen's HVM device model
```
