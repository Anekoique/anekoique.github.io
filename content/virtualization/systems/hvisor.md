---
date: '2026-06-27T20:00:00+08:00'
draft: false
title: 'Virtualization Systems — hvisor'
slug: 'hvisor'
tags: ["Virtualization", "Hypervisor", "Systems", "Rust", "hvisor"]
series: ["Virtualization Series"]
summary: "Rust separation-kernel Type-1 hypervisor from Syswonder, descended from Jailhouse and RVM1.5. Static partitioning of hardware into isolated zones, no CPU scheduler, no overcommit, virtio trampoline for paravirtual I/O."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

hvisor is a Type-1 bare-metal hypervisor written in Rust by the Syswonder group, distributed under the Mulan PSL v2. The design is explicitly acknowledged as descended from [Jailhouse](https://github.com/siemens/jailhouse) (Siemens, C) and [RVM1.5](https://github.com/rcore-os/RVM1.5) (rCore, Rust), and reads as a Rust re-architecture of Jailhouse's separation-kernel philosophy: a small VMM that statically partitions a fixed pool of hardware resources among a fixed set of isolated *zones*, with no dynamic CPU scheduling and no memory overcommit.

This places hvisor at: **Type-1 placement / mixed guest interface (unmodified guests on full virtualization, with paravirt I/O via a virtio trampoline) / hardware-assisted on every supported ISA / hardware (page-table + privilege-ring) isolation boundary**. It is the closest production-shape precedent for the *placement* and *static-resource* aspects of Astervisor, while remaining firmly on the hardware-isolation side of the fourth taxonomy axis.

## Tuple in the §02 frame

| Axis | hvisor |
|---|---|
| Placement | Type-1 bare-metal; runs at EL2 / HS / VMX-root / PLV0 |
| Guest interface | Full virtualization (Linux, Zephyr, RT-Thread, Android run unmodified); paravirt I/O via virtio MMIO with a dom0-style backend in zone0 |
| Hardware support | Mandatory two-stage paging (Stage-2 PT on every arch); CPU virtualization extensions; optional IOMMU (Arm SMMU, RISC-V IOMMU, Intel VT-d) |
| Isolation boundary | Hardware. Each zone has its own Stage-2 page table; CPUs are *statically* partitioned, not scheduled; `unsafe` is used freely throughout the VMM |

The defining architectural choice is *static partitioning*: a zone owns a fixed subset of pCPUs (a `CpuSet` bitmap, see `src/cpu_data.rs:107`), a fixed range of host-physical memory, and a fixed set of interrupts. There is no vCPU scheduler. Each pCPU runs at most one zone, forever.

## Separation-kernel zone model

hvisor's defining structural concept is the **zone**. A running system is made up of three classes of zone, mapped from the Jailhouse `root cell` / `non-root cell` distinction onto a domain-typed model:

- **zone0** — the management zone. A Linux instance (`root-linux`) that hosts the `hvisor-tool` user-space utilities, owns all devices not explicitly handed to another zone, and is the only zone permitted to issue lifecycle hypercalls.
- **zoneU** — user zones. Application VMs (Linux, Android, Zephyr, RT-Thread) used for general-purpose workloads.
- **zoneR** — real-time zones. Same mechanism as zoneU but allocated CPUs and devices with isolation strong enough for hard-real-time guests.

The on-disk type that backs all three is identical — a single `Zone` struct holding the zone's name, id, error state, and an `RwLock<ZoneInner>` with the per-zone state (`src/zone.rs:111`):

```rust
pub struct ZoneInner {
    mmio: Vec<MMIOConfig>,            // emulated MMIO regions + handlers
    cpu_num: usize,
    cpu_set: CpuSet,                  // static pCPU partition (bitmap)
    irq_bitmap: [u32; 1024 / 32],     // statically owned IRQs
    gpm: MemorySet<Stage2PageTable>,  // guest physical memory map (Stage-2 PT)
    iommu_pt: Option<MemorySet<Stage2PageTable>>,  // IOMMU table (if present)
    vpci_bus: VirtualRootComplex,     // per-zone virtual PCI root complex
    ...
}
```

The first zone is created in-VMM from a baked-in root config (`primary_init_early` in `src/main.rs:138`); subsequent zones are created by zone0 calling the `HvZoneStart` hypercall (see "Control plane" below).

The role of zone0 is closer to a Xen-style `dom0` than to a co-equal guest: it is the device backend for paravirt I/O, it owns the `hvisor-tool` user-space utilities, and it is the only zone allowed through the privileged hypercall paths (`is_this_root_zone()` checks in `src/hypercall/mod.rs:111,137,182,219`).

## Anatomy in the §03 frame

The same six components our anatomy chapter names appear in hvisor:

| §03 component | hvisor location |
|---|---|
| Control plane | `hypercall::HyperCall::hv_zone_start` / `_shutdown` / `_list` (`src/hypercall/mod.rs`) |
| vCPU model | `PerCpu` + `ArchCpu` (`src/cpu_data.rs:30`, `src/arch/<arch>/cpu.rs`) — one vCPU per pCPU, no scheduler |
| Memory model | `MemorySet<Stage2PageTable>` per zone (`src/memory/mm.rs`, `src/arch/<arch>/s2pt.rs`) |
| Device model | virtio trampoline (`src/device/virtio_trampoline.rs`) + per-arch irqchip / IOMMU under `src/device/{irqchip,iommu}` |
| Interrupt/timer | Architecture irqchip (GICv2/v3, PLIC, AIA, LS7A2000, APIC) + per-zone IRQ bitmap |
| Exit handler | `arch_handle_exit` in each arch's `trap.rs` (`src/arch/aarch64/trap.rs:109`) |

The shape this lands in (using [§03](/virtualization/vmm-architecture/)'s three-shape vocabulary) is **monolithic with a hosted device backend**. The hypervisor itself is one privileged binary with no internal isolation between components — Stage-2 page tables, virtio queues, and irqchip handlers all live in the single EL2 address space — but the *device data path* is delegated to user-space helpers running in zone0's Linux, in a way that mirrors a hosted VMM's user-mode device helper without that VMM having user/kernel separation inside itself. A spectrum-position somewhere between Jailhouse's pure-monolithic shape and Xen's disaggregated-driver-domain shape.

## CPU model — static partitioning, no scheduler

The most distinctive design choice. Where every system in [§04](/virtualization/cpu/)'s scheduling discussion presupposes a scheduler that picks vCPUs onto pCPUs, hvisor **does not have one**. The mapping is established at zone creation and never changes:

```rust
// src/zone.rs:415 — at zone_create
for cpu_id in config.cpus().iter() {
    if let Some(existing_zone) = get_cpu_data(*cpu_id as _).zone.clone() {
        return hv_result_err!(EBUSY, ...);  // already claimed
    }
    zone.write().cpu_set_mut().set_bit(*cpu_id as _);
    ...
}
```

A `PerCpu` (`src/cpu_data.rs:30`) holds a single `Arc<Zone>` field; the relation "this pCPU runs this zone" is therefore literally `1:1`. The boot-time flow is: every pCPU enters Rust through `rust_main` (`src/main.rs:188`), barriers until all are present, the primary CPU runs `primary_init_early`/`_late`, then **each pCPU calls `cpu.run_vm()` and never returns** (`src/cpu_data.rs:72`). On AArch64, `ArchCpu::run` (`src/arch/aarch64/cpu.rs:184`) installs the zone's Stage-2 page table, configures `HCR_EL2`/`VTCR_EL2`, and `eret`s into the guest. From this point the pCPU only re-enters EL2 on a trap; the trap handler dispatches and re-enters the same zone.

Concrete implications, set against [§04](/virtualization/cpu/):

- **No vCPU scheduling cost.** No save/restore of vCPU register sets on context switch — there is no context switch.
- **No lock-holder preemption.** The pathology §04 names doesn't arise; a guest spinlock can't be held by a descheduled vCPU because no vCPU is ever descheduled.
- **No CPU overcommit.** A zone with N vCPUs requires N dedicated pCPUs. The system can host at most `MAX_CPU_NUM` vCPUs total, regardless of how it slices them across zones.
- **vCPU state lives in arch-specific contexts**, not in a uniform "vCPU struct": `ArchCpu` on AArch64 is essentially `{cpuid, is_aarch32, power_on}` (`src/arch/aarch64/cpu.rs:68`); guest GPRs live in a `GeneralRegisters` struct on the per-CPU stack between exits.

The cooperative-not-preemptive aspect is striking from a Rust-OS-survey angle: hvisor pays for cooperation not by changing the *guest interface* (as Xen-PV does) but by changing the *VMM scheduling model* (as a separation kernel does). The guest is unmodified, but the resource it runs on is statically reserved.

## Memory model — Stage-2 PT, no overcommit, no shadow

Memory is also statically partitioned. `zone_create` calls `pt_init` with a list of `(physical_start, virtual_start, size, flags)` regions from the config; these become entries in the zone's `MemorySet<Stage2PageTable>` (`src/zone.rs:388`). A region is a direct guest-physical → host-physical mapping; once installed, it does not move.

Architectural realization tracks [§05](/virtualization/memory/)'s two-stage-paging discussion exactly:

- **AArch64**: Stage-2 translation via `VTCR_EL2` + `VTTBR_EL2` (set up in `ArchCpu::activate_vmm`, `src/arch/aarch64/cpu.rs:106`). The Stage-2 PT is in `src/arch/aarch64/s2pt.rs`.
- **RISC-V**: G-stage translation via the H-extension; `s2pt.rs` under `src/arch/riscv64/`.
- **LoongArch64**: Stage-2 paging via `s2pt.rs` under `src/arch/loongarch64/` (with a `s1pt.rs` for the Stage-1 hypervisor mapping).
- **x86_64**: EPT via VMX; `s2pt.rs`, `vmx.rs`, and `vmcs.rs` under `src/arch/x86_64/`.

The §05 mechanisms that hvisor **does not implement**:

- **No shadow page tables.** Every supported architecture has nested paging; hvisor depends on it.
- **No demand allocation, ballooning, page sharing, swapping, or idle taxation.** Memory is sized at zone-config time. The §05 "overcommit toolbox" is empty.
- **No live migration.** Without movable memory and without serializable device state, there is nowhere to migrate to.

The `MemFlags` set in `src/memory/mod.rs:36` does include a `COMMUNICATION` flag, suggesting inter-zone-shared regions for the IVC mechanism (see "Cross-domain communication" below), but the sharing is set up at config time and is not a general overcommit primitive.

The configurations of choice are recovered as benefits: the §05 "Memory Protection Between Guests" subsection — "the translation table *is* the protection" — applies cleanly because there is no path by which a guest can acquire memory it was not pre-assigned. The complexity of dynamic allocation, balloon drivers, COW-shared pages, and swap I/O is simply absent from the codebase.

## I/O model — virtio trampoline with zone0 backend

This is the single most interesting mechanism in hvisor and the one most directly relevant to [§06](/virtualization/io/) and [§07](/virtualization/communication/). hvisor presents `virtio-blk`, `virtio-net`, `virtio-console`, and `virtio-gpu` to non-root zones, but the **device backends do not live in the hypervisor**. They live as user-space processes in zone0's Linux (the `hvisor-tool` codebase). The hypervisor contains only a thin trampoline.

### The shared ring

A single page of host-physical memory, mapped by zone0's user-space backend *and* readable by the hypervisor, holds a `VirtioBridge` structure (`src/device/virtio_trampoline.rs:333`):

```rust
struct VirtioBridge {
    req_front: ReadWrite<u32>,   // virtio device updates
    req_rear:  ReadWrite<u32>,   // hvisor updates
    res_front: ReadWrite<u32>,   // hvisor updates
    res_rear:  ReadWrite<u32>,   // virtio device updates
    req_list: [HvisorDeviceReqVolatile; MAX_REQ],  // submission ring (32 slots)
    res_list: [HvisorDeviceResVolatile; MAX_REQ],  // completion ring (irq IDs)
    cfg_flags:  [ReadWrite<u64>; MAX_CPUS],        // per-pCPU cfg-done flag
    cfg_values: [ReadWrite<u64>; MAX_CPUS],        // per-pCPU cfg result
    need_wakeup: ReadWrite<u8>,
}
```

This is — in [§07](/virtualization/communication/)'s vocabulary — a **shared-memory ring** with a SPSC pair of rings (one for requests, one for completions), plus a per-pCPU scratch area for synchronous config-space reads. Notification is via the `need_wakeup` flag plus an SGI to wake zone0 when it has gone idle.

### The submission path

When a non-root zone touches a virtio MMIO register, the access traps to EL2 (Stage-2 fault on an MMIO region the hypervisor has marked as needing emulation), routes through `find_mmio_region` (`src/zone.rs:246`), and lands in `mmio_virtio_handler` (`src/device/virtio_trampoline.rs:65`). The handler:

1. Builds an `HvisorDeviceReq` from the access (src CPU, address, size, value, src zone, R/W, "needs interrupt?").
2. Pushes it into `req_list` with an exponential-backoff loop on ring-full, releasing the bridge lock between retries to avoid deadlocking against zone0's CPU racing for the same lock.
3. Issues a `Release` fence so the backend sees the data before the index bump.
4. If `need_wakeup` is set, sends an SGI (IPI) to zone0 via `IPI_EVENT_WAKEUP_VIRTIO_DEVICE` to bring the backend out of idle.
5. For data-path writes (`need_interrupt == 1`), returns immediately — completion is asynchronous. For config-space reads (`need_interrupt == 0`), spins on the per-pCPU `cfg_flags[cpu_id]` until the backend writes through `cfg_values[cpu_id]`, then returns the result to the guest.

### The completion path

The user-space backend in zone0, after completing an I/O, populates a slot in `res_list` and bumps `res_rear`, then issues the `HvVirtioInjectIrq` hypercall (id 1). The hypercall handler (`src/hypercall/mod.rs:135`) drains the response ring, looks up the target zone, picks the boot CPU of that zone with `get_target_cpu`, builds a per-CPU list of pending IRQ IDs in `VIRTIO_IRQS` (a `Mutex<BTreeMap<usize, [u64; MAX_DEVS+1]>>`), and sends that pCPU an `IPI_EVENT_VIRTIO_INJECT_IRQ` SGI. When the target pCPU processes the SGI in its trap handler, `handle_virtio_irq` (`src/device/virtio_trampoline.rs:158`) injects the queued IRQs into the zone's virtual interrupt controller.

### What this looks like in the §06 frame

In [§06](/virtualization/io/)'s three-approach table, hvisor's virtio path is squarely "Virtio (Paravirtual) — user-space backend": guest modification = paravirt driver (part of guests' standard virtio-mmio drivers); VMM on data path = shared ring + notifications; performance class = "good", not near-native.

The unusual feature is *where the backend lives*. In a hosted VMM (KVM + QEMU), the user-space backend runs on the host kernel; in hvisor, there is no host kernel — the backend runs *inside zone0 itself*, a regular Linux guest, talking to the hypervisor through a hypercall API rather than a syscall/ioctl API. This is structurally close to the [§03](/virtualization/vmm-architecture/) discussion of Xen's `dom0` driver domain, but transplanted onto a virtio interface instead of Xen's split-driver model.

Two consequences worth naming:

- **TCB.** The hypervisor proper carries no device-emulation code. A virtio-blk bug is contained in a zone0 user-space process and cannot corrupt the hypervisor — which is what the Jailhouse-descended separation-kernel design is selling.
- **Per-IO cost.** Every guest I/O round-trips: Stage-2 trap → `mmio_virtio_handler` → ring push → SGI to zone0 → zone0 wakes → backend reads ring → real I/O on zone0's Linux → `HvVirtioInjectIrq` hypercall → SGI to target zone's pCPU → IRQ injected. The cost is the §07 "amortize via batching" pattern, with the backend running as a Linux user process rather than as a kernel-resident `vhost` target. Compared to KVM+vhost, there is one extra hop (through zone0's Linux user-kernel boundary) and one fewer hop (no host→guest VM switch because zone0's pCPUs aren't multiplexed with anything else).

### Device passthrough

For devices not virtualized through virtio, hvisor supports straight passthrough (PCIe, GPU, eMMC, USB, SATA, Ethernet — see the device-support table in `README.md`). With passthrough, the device's MMIO BARs are mapped directly into the owning zone's Stage-2 PT, IOMMU translation (`iommu_pt: Option<MemorySet<Stage2PageTable>>`, `src/zone.rs:124`) confines DMA, and interrupts are routed to the zone's vCPU through the per-arch irqchip. This is the §06 "Pass-through / SR-IOV" column: the VMM is not on the data path.

The `vpci_bus: VirtualRootComplex` in each `ZoneInner` is a per-zone virtual PCI host bridge, used to present a zone-specific PCIe topology even when the underlying device is passed through. Implementation lives under `src/pci/`.

## Control plane — hypercall API and zone0

The control plane is small. The full hypercall table is the `HyperCallCode` enum (`src/hypercall/mod.rs:34`):

| Code | Op | Caller | Purpose |
|---|---|---|---|
| 0 | HvVirtioInit | zone0 | Register the shared virtio-bridge page |
| 1 | HvVirtioInjectIrq | zone0 | Drain res ring, inject IRQs to target zones |
| 2 | HvZoneStart | zone0 | Create + boot a new zone |
| 3 | HvZoneShutdown | zone0 | Tear down a zone, reclaim its pCPUs |
| 4 | HvZoneList | any | Enumerate active zones |
| 5 | HvIvcInfo | any | Inter-VM-communication configuration query |
| 6 | HvConfigCheck | zone0 | Magic-version handshake with hvisor-tool |
| 20 | HvClearInjectIrq | zone0 | Broadcast IPI to clear pending virtio IRQs |
| 86 | HvVirtioGetIrq | (arch-specific) | RISC-V-only: fetch pending virtio IRQ |

The lifecycle operations 2 and 3 are the most informative. `HvZoneStart` (`src/hypercall/mod.rs:176`):

1. Refuses unless caller is in zone0.
2. Validates `config_size` matches `sizeof(HvZoneConfig)`.
3. Calls `zone_create(config)`, which builds the `Zone` (Stage-2 PT, MMIO handler vector, IRQ bitmap, virtio PCI vbus, optional IOMMU PT, per-arch pre/post-config hooks).
4. Locates the zone's boot pCPU (`zone.cpu_set().first_cpu()`).
5. Sends `IPI_EVENT_WAKEUP` (SGI) to that pCPU.

The targeted pCPU was previously sitting in a parking loop (see "Power states" below); receiving the SGI causes it to dispatch the event and re-enter guest mode at the new zone's entry point. Because there is no scheduler, the rest of the zone's pCPUs are already idle on dedicated pCPUs and will wake themselves the same way.

`HvZoneShutdown` (`src/hypercall/mod.rs:217`) sends `IPI_EVENT_SHUTDOWN` to every pCPU in the zone, spins until all of them confirm `power_on == false` (with `MAX_WAIT_TIMES` retries), nulls out their `zone` fields, resets the zone's irqchip, releases any PCI devices the zone owned, and removes the `Zone` from `ZONE_LIST`.

The hypercall ABI is closer to a Jailhouse / paravirt-management ABI than to a Xen hypercall ABI: a small, fixed set of operations focused on zone *lifecycle* rather than on hot-path optimization. It is not a substitute for a system-call ABI — guests still run their kernels' normal syscall paths inside their own EL1 — it is purely the management surface zone0 uses to drive the hypervisor.

## Cross-domain communication — three layers

hvisor has three distinct communication mechanisms, each at a different point on [§07](/virtualization/communication/)'s design space:

1. **Hypercalls** (§07 "synchronous boundary crossings"). The 9 codes listed above. Used only for control-plane operations and the virtio completion-injection callback.

2. **Virtio shared ring** (§07 "shared-memory rings"). The `VirtioBridge` page described under "I/O model". This is the dominant data-path mechanism. Notification via SGI, batched submission with exponential-backoff on ring-full, asynchronous completion via completion ring plus injected IRQ.

3. **IVC (Inter-VM Communication)** (§07 "memory sharing and grant tables"). A separate mechanism, with per-zone configuration in `IVC_INFOS` and a query hypercall `HvIvcInfo` (`src/arch/aarch64/hypercall.rs:27`). Memory regions can be marked `MemFlags::COMMUNICATION` in a zone's config, mapping the same host pages into multiple zones' Stage-2 tables; zones then communicate in-band over the shared region with semantics they implement themselves. Lighter-weight than a Xen grant table — there is no revocation, no per-page authorization, no copy-only mode — but it serves the same role as the "explicit cross-domain shared memory" primitive in disaggregated VMMs.

The IPC layer is also the substrate the *internal* event system rides on. `src/event.rs` defines a per-pCPU `Mutex<VecDeque<usize>>` of queued event IDs (`IPI_EVENT_WAKEUP`, `IPI_EVENT_SHUTDOWN`, `IPI_EVENT_VIRTIO_INJECT_IRQ`, `IPI_EVENT_WAKEUP_VIRTIO_DEVICE`, `IPI_EVENT_CLEAR_INJECT_IRQ`, `IPI_EVENT_UPDATE_HART_LINE`, `IPI_EVENT_SEND_IPI`). `send_event(cpu, sgi_id, event)` pushes onto the target pCPU's queue and fires an SGI; the target pCPU's trap handler drains the queue in `check_events()` and dispatches each. This is hvisor's in-hypervisor IPC: not a guest-visible mechanism, but a per-pCPU event mailbox the hypervisor uses to coordinate its own work.

## Power states — parking instead of context-switching

Because pCPUs are dedicated and not multiplexed, a "stopped" zone leaves its pCPUs *somewhere*. hvisor's answer: park them in the guest, executing `wfi`/`hlt` in a one-page "parking" memory map.

`ArchCpu::idle` on AArch64 (`src/arch/aarch64/cpu.rs:212`):

1. Acquires the per-CPU control lock and sets `power_on = false`.
2. Lazily constructs `PARKING_MEMORY_SET` containing one page at GPA 0 filled with `wfi; b 1b` (the two-instruction infinite wait-for-interrupt loop, hex-encoded as `[0x7f, 0x20, 0x03, 0xd5, 0xff, 0xff, 0xff, 0x17]`).
3. Resets vCPU registers to entry-point 0, activates the parking Stage-2 PT, and `vmreturn`s — the pCPU is now executing `wfi` *as a guest*, in a one-page guest address space.

When zone0 later issues `HvZoneStart` and the wakeup SGI arrives, the pCPU exits the parking loop on the SGI exception, drops back to EL2, picks up the queued `IPI_EVENT_WAKEUP`, and re-runs `ArchCpu::run` with the new zone's entry point and Stage-2 PT. There is never a moment when a pCPU is not running a guest; "stopped" is just "running a one-page guest that loops".

This is unusual enough to be worth flagging: it solves the "what does a CPU do when its zone is gone" problem without introducing a hypervisor scheduler, at the cost of always having a Stage-2 page table active even on idle pCPUs.

## Interrupt and timer model

Per-arch irqchip drivers under `src/device/irqchip/`:

- **aarch64**: GICv2, GICv3
- **riscv64**: PLIC, AIA (MSI mode), ACLINT
- **loongarch64**: 7A2000 bridge irq controller
- **x86_64**: APIC, plus a legacy PIC stub

Each zone has its own `irq_bitmap` (`src/zone.rs:122`) listing the IRQs it owns. The irqchip driver routes hardware interrupts to whichever zone's pCPU owns that IRQ; for SGIs (inter-CPU events), the event subsystem above multiplexes hvisor's own control events onto SGI 7 (`SGI_IPI_ID`, `src/hypercall/mod.rs:49`).

Timers are per-arch: each guest runs against the architectural timer of its dedicated pCPU. Because the pCPU is not time-sliced, there is no virtual-timer multiplexing to do — the guest sees the real timer at full fidelity. The [§03](/virtualization/vmm-architecture/) "time virtualization" complications (TSC skew across migration, vCPU descheduling jitter) do not arise.

## Multi-arch portability

`#[cfg(target_arch = ...)]` switches in `src/arch/mod.rs`, with parallel subtrees:

| Arch | Files in `src/arch/<arch>/` | Distinctive files |
|---|---|---|
| aarch64 | 17 files, GICv2/v3 | `entry.rs`, `mmu.rs`, `s2pt.rs`, `trap.S` |
| riscv64 | 15 files, H-extension | `csr.rs`, `sbi.rs`, `s2pt.rs` |
| loongarch64 | 14 files | `clock.rs`, `register/`, `s1pt.rs`+`s2pt.rs` |
| x86_64 | 22 files, VMX | `vmcs.rs`, `vmx.rs`, `acpi.rs`, `multiboot.S` |

The portability story is "implement the same `arch` interface on every target" — `ArchCpu`, Stage-2 PT, trap vector, IPI primitives, time — without an explicit trait abstraction; each arch module re-exports its contents through `pub use <arch>::*`. The x86_64 port is by far the largest because it has to deal with VMX (VMCS, VM-entry/exit) on top of the generic mechanisms — a counter-example to [§04](/virtualization/cpu/)'s "ARM and RISC-V had the easier starting condition" observation, with hvisor paying the same extra-complexity-on-x86 cost every hardware-assisted VMM does.

## Verification angle

hvisor's README claims that "part of the hvisor code is undergoing formal verification using the [Verus](https://github.com/verus-lang/verus) tool". The codebase I read does not contain in-tree Verus annotations, so this is an out-of-tree research effort rather than a CI-enforced property at the moment, but the *posture* — claiming formal verifiability as a goal of a Rust hypervisor — is shared with the Astervisor premise. It is the clearest near-precedent for the language-isolation-validating direction Astervisor takes further.

## Relationship to Astervisor

hvisor is, on every axis except the fourth, the closest production-shape template for Astervisor's intended design:

| Choice | hvisor | Astervisor (planned) |
|---|---|---|
| Placement | Type-1 on bare metal | Type-1 on OSTD |
| Guest interface | Full virt + paravirt I/O (unmodified guests) | Paravirt cooperating Rust guests |
| Hardware support | CPU virt + Stage-2 PT mandatory | Minimal — MMU + privilege rings only |
| Isolation boundary | **Hardware** (Stage-2 PT, privilege levels) | **Language** (Rust type system) |
| CPU model | Static partitioning, no scheduler | Round-robin scheduler (Phase 2+) |
| Memory model | Static zone-config, no overcommit | Per-domain regions, no two-stage |
| I/O model | virtio trampoline → zone0 user-space backend | Typed channels to device-backend domains |
| Cross-domain comm | Hypercalls + virtio ring + IVC shared mem | Single mechanism: typed Rust channels |
| Multi-arch | aarch64 / riscv64 / loongarch64 / x86_64 | x86_64 first, RISC-V via OSTD later |

The single largest divergence is the *guest interface* axis: hvisor's willingness to host unmodified Linux drives most of its hardware-support requirements (Stage-2 PT on every arch, full VT-x/AMD-V on x86), where Astervisor's commitment to cooperating Rust guests is what makes the "minimal hardware support" column of its tuple achievable.

The two most informative *positive* lessons for Astervisor:

- **Static partitioning works.** A separation-kernel CPU model — no scheduler, dedicated pCPUs per zone — is small to implement and eliminates several hard problems (lock-holder preemption, fairness, multi-vCPU coordination) at once. Astervisor's Phase 1 chooses a round-robin scheduler for generality, but hvisor demonstrates the "no scheduler at all" point in the design space is viable for many workloads.
- **Trampoline-style device backends.** Putting the device backend in a privileged management VM (zone0 / `dom0`) and connecting it to the hypervisor through a single shared-page ring is a clean way to keep device code out of the TCB without paying a full microkernel-style multi-domain-IPC cost. Astervisor's planned "device backends are themselves domains" architecture is closest to this shape; hvisor's virtio trampoline is concrete prior art for that boundary.

The two most informative *cautionary* lessons:

- **`unsafe` is everywhere.** hvisor uses `unsafe` freely — raw-pointer arithmetic over `VirtioBridge` (`virtio_trampoline.rs:218`), raw `&mut` on PerCpu globals (`cpu_data.rs:92`), `unsafe extern "C"` linkage symbols, `.unwrap()` calls in non-test paths (`zone.rs:344`, `cpu_data.rs:104`). It is a Rust hypervisor by *language choice*, not by safety-budget discipline. Astervisor's `#![deny(unsafe_code)]` in `visor/` is a structurally different commitment.
- **No abstraction over architectures.** The "re-export per-arch module with `pub use <arch>::*`" pattern works at small scale but means each arch port duplicates rather than implements an interface. A fifth port would re-confront every cross-cutting concern. For Astervisor, the §02 SPEC R6–R7 organization rules (canonical short-name arch directories mirroring generic layout) take a different stance.

## Source map

Quick-reference index for the files cited above:

```text
src/
├── main.rs                       — entry, boot ordering, primary_init_*
├── zone.rs                       — Zone / ZoneInner, zone_create, ZONE_LIST
├── cpu_data.rs                   — PerCpu, CpuSet, get_cpu_data, this_zone
├── event.rs                      — per-pCPU event queue, send_event, check_events
├── config.rs                     — HvZoneConfig structures
├── hypercall/
│   └── mod.rs                    — HyperCallCode enum, arch-generic handlers
├── memory/
│   ├── mod.rs                    — MemFlags, MemorySet, PAGE_SIZE
│   ├── mm.rs                     — MemorySet / MemoryRegion impl
│   ├── mapper.rs                 — page-table mapping helpers
│   └── mmio.rs                   — MMIOConfig, MMIOAccess, mmio_handle_access
├── device/
│   ├── virtio_trampoline.rs      — VirtioBridge ring + handlers
│   ├── irqchip/                  — GICv2/v3, PLIC, AIA, LS7A2000, APIC
│   ├── iommu/                    — Arm SMMU, Intel VT-d, RISC-V IOMMU
│   └── uart/                     — per-platform UART drivers
├── pci/                          — virtual root complex, BAR allocation, ECAM
├── arch/
│   ├── aarch64/                  — EL2 entry, GIC trap, Stage-2 PT, PSCI
│   ├── riscv64/                  — H-ext entry, SBI shim, G-stage PT
│   ├── loongarch64/              — PLV0 entry, 7A2000 irq, S1+S2 PT
│   └── x86_64/                   — VMX entry, VMCS/VMX, EPT, APIC
└── platform/                     — per-board constants (MPIDR maps, MMIO bases)
```

The `tools/` directory contains shell scripts only (build helpers, license check, cargo-config generator); the user-space `hvisor-tool` counterpart and the actual virtio backends live in a separate repository ([syswonder/hvisor-tool](https://github.com/syswonder/hvisor-tool)).
