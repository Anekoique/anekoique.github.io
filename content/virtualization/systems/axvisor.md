---
date: '2026-06-27T19:00:00+08:00'
draft: false
title: 'Virtualization Systems — AxVisor'
slug: 'axvisor'
tags: ["Virtualization", "Hypervisor", "Systems", "Rust", "ArceOS"]
series: ["Virtualization Series"]
summary: "Rust Type-1 hypervisor built as an application of the ArceOS unikernel: vCPUs are scheduled as ArceOS tasks, and the hypervisor is a thin shell over a stack of arceos-hypervisor crates (axvm, axvcpu, axaddrspace, axdevice, axhvc)."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

AxVisor is a Type-1 Rust hypervisor developed by the [arceos-hypervisor](https://github.com/arceos-hypervisor) project as a research/engineering follow-on to [ArceOS](https://github.com/arceos-org/arceos), the modular unikernel framework from Tsinghua. Distributed under Apache-2.0. The defining architectural choice is in the README's opening line: "AxVisor is a Hypervisor implemented based on the ArceOS kernel." That sentence is not metaphorical — **AxVisor is literally an ArceOS application**, linked against ArceOS as an `axstd` consumer, where the application's `main()` happens to be a hypervisor instead of a workload.

This places AxVisor at: **Type-1 placement on top of an ArceOS unikernel runtime / paravirt-and-full mixed guest interface / mandatory hardware-assisted virtualization on every supported arch / hardware (page-table + privilege) isolation boundary**. Its distinctive shape — among the systems in this directory — is the layering: where hvisor and Xen *are* their own kernels, AxVisor *is hosted on* a unikernel that provides scheduler, allocator, paging, IRQ, SMP, multitask, and console primitives. The hypervisor itself is the integration glue plus arch-generic vmexit dispatch.

A second defining choice: **AxVisor is a thin shell over a stack of hypervisor crates**, also from arceos-hypervisor: `axvm` (VM abstraction), `axvcpu` (vCPU abstraction), `axaddrspace` (guest address space + EPT/stage-2), `axdevice` (virtual devices), `axhvc` (hypercall ABI). The `axvisor` repo itself is ~2 KLoC of Rust, organized around a `vmm` module that orchestrates these crates. Most of "what makes AxVisor a hypervisor" is in the crates, not the binary.

## Tuple in the §02 frame

| Axis | AxVisor |
|---|---|
| Placement | Type-1 — runs at EL2 / VMX-root / HS-mode, but *hosted on the ArceOS unikernel runtime*. The ArceOS code is in the same privileged binary, not in a guest |
| Guest interface | Three coexisting models: **full virt + paravirt I/O** for Linux/Starry-OS/NimbOS guests; **cooperating-Rust** for ArceOS-as-guest |
| Hardware support | Mandatory two-stage paging (EPT/NPT on x86, Stage-2 on aarch64, G-stage on riscv64); CPU virtualization extensions (VMX/SVM/EL2/H-ext) required on every supported arch |
| Isolation boundary | Hardware. Per-domain Stage-2 page table; vCPU runs deprivileged in non-root mode; vCPUs scheduled cooperatively as ArceOS tasks. `unsafe` used freely throughout |

The defining structural choice is **the hypervisor and its runtime are the same binary**. There is no `dom0` (Xen-style) or `zone0` (hvisor-style) Linux management VM, and there is no separate scheduler in the hypervisor (Xen-style). The ArceOS unikernel *is* the runtime: ArceOS's scheduler schedules vCPUs as ordinary tasks, ArceOS's allocator allocates guest memory frames, ArceOS's IRQ subsystem dispatches hardware interrupts. Management ("create VM", "list VMs", "stop VM") is a shell that runs as another ArceOS task in the same address space.

## How AxVisor is layered on ArceOS

The architecture is easiest to see as a stack:

```
  ┌─────────────────────────────────────────────────────────────┐
  │  AxVisor binary (single privileged binary at EL2/VMX-root)  │
  │ ─────────────────────────────────────────────────────────── │
  │   src/main.rs        — boot: hal::enable_virt + vmm::init   │
  │   src/vmm/           — vCPU run loop, hvc, ivc, config      │
  │   src/hal/           — AxVMHal / AxVCpuHal / AxMmHal impls  │
  │   src/shell/         — interactive command shell            │
  │   src/driver/        — block / serial / SoC drivers         │
  │ ─────────────────────────────────────────────────────────── │
  │  hypervisor crates  (arceos-hypervisor org)                 │
  │   axvm               — AxVM, AxVMConfig, AxVMPerCpu         │
  │   axvcpu             — AxVCpu, AxVCpuExitReason             │
  │   axaddrspace        — guest physical addr, Stage-2 tables  │
  │   axdevice + axdevice_base  — virtual devices, vMMIO trap   │
  │   axhvc              — HyperCallCode enum, ABI defs         │
  │   axvisor_api        — extern_trait API surface             │
  │ ─────────────────────────────────────────────────────────── │
  │  ArceOS unikernel    (consumed via axstd with "hv" feature) │
  │   axtask             — task = vCPU; wait queue; scheduler   │
  │   axhal              — pCPU, time, IRQ, paging primitives   │
  │   axalloc            — page/frame/heap allocator            │
  │   axplat             — platform drivers (UART, timer, …)    │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       physical hardware
```

The boot sequence is the cleanest demonstration of the layering. `axvisor/src/main.rs` (55 LoC total):

```rust
fn main() {
    logo::print_logo();
    hal::enable_virtualization();   // enable VMX/SVM/EL2 on every pCPU
    vmm::init();                    // parse VM configs, create VM structs, spawn primary vCPU tasks
    vmm::start();                   // boot each VM; wait until all VMs exit
    shell::console_init();          // drop into interactive shell
}
```

There is no kernel entry, no IDT/GDT setup, no scheduler init, no memory init — all of it is done by ArceOS *before* `main()` runs, exactly as in any ArceOS application. AxVisor's `main()` is the application; ArceOS is the OS underneath.

## Anatomy in the §03 frame

| §03 component | AxVisor location |
|---|---|
| Control plane | TOML configs in `configs/vms/` + `cargo xtask build` (compile-time integration) + runtime shell in `axvisor/src/shell/` |
| vCPU model | `axvm::AxVCpu` (sibling crate at `axvm/`) wrapped in `VCpuTask` (`axvisor/src/task.rs:21`) so it can be scheduled as an `axtask` |
| Memory model | `axaddrspace/` — per-VM Stage-2 page table; allocation goes through ArceOS's `axalloc` |
| Device model | `axdevice/` + `axdevice_base/` for virtual devices; `axvisor/src/driver/` for host driver wrappers; PV split or passthrough |
| Interrupt/timer | ArceOS's `axhal::irq` + `axvisor/src/vmm/timer.rs` for vCPU-targeted timers |
| Exit handler | `vcpu_run()` in `axvisor/src/vmm/vcpus.rs:432` — the central match on `AxVCpuExitReason` |

The [§03](/virtualization/vmm-architecture/) shape this lands in: **monolithic-in-a-unikernel**. There's no internal isolation between AxVisor and ArceOS (they're the same binary); there's no dom0-equivalent (ArceOS provides drivers directly); the hypervisor data path goes straight from `vcpu_run` to the device handler to the ArceOS-owned hardware driver. Closer to a hosted shape philosophically (hypervisor reuses a kernel's mechanisms) but with no host/guest distinction — there's no "host OS underneath" to host into. ArceOS is statically linked.

## CPU model — vCPUs are ArceOS tasks

The single most important design choice in AxVisor. Where Xen has its own scheduler with 4273 LoC and hvisor has no scheduler at all (static partition), AxVisor's answer is:

> **Each vCPU is an ArceOS task.** ArceOS's `axtask` scheduler picks which vCPU runs on which pCPU at each scheduling decision.

The mechanism in `axvisor/src/task.rs:21`:

```rust
pub struct VCpuTask {
    pub vm: Weak<VM>,
    pub vcpu: VCpuRef,
}

#[extern_trait::extern_trait]
impl TaskExt for VCpuTask {}
```

A `VCpuTask` extends `TaskInner` (ArceOS's task control block) with two fields: a weak reference to the parent VM and a strong reference to the `AxVCpu`. The task's entry function is `vcpu_run` in `axvisor/src/vmm/vcpus.rs:432`. From ArceOS's perspective, a vCPU task is indistinguishable from any other kernel task — same scheduler, same wait queues, same affinity mask, same join semantics.

`alloc_vcpu_task` (`axvisor/src/vmm/vcpus.rs:403`) spawns it:

```rust
fn alloc_vcpu_task(vm: &VMRef, vcpu: VCpuRef) -> AxTaskRef {
    let mut vcpu_task = TaskInner::new(
        vcpu_run,
        format!("VM[{}]-VCpu[{}]", vm.id(), vcpu.id()),
        KERNEL_STACK_SIZE,   // 256 KiB
    );
    if let Some(phys_cpu_set) = vcpu.phys_cpu_set() {
        vcpu_task.set_cpumask(AxCpuMask::from_raw_bits(phys_cpu_set));
    }
    *vcpu_task.task_ext_mut() = Some(AxTaskExt::from_impl(VCpuTask::new(vm, vcpu)));
    axtask::spawn_task(vcpu_task)
}
```

The vCPU's optional `phys_cpu_set` becomes the ArceOS task's CPU affinity mask — letting users pin a vCPU to a specific pCPU via the VM config, while still scheduling cooperatively when there's no pin. This is "hvisor's static partitioning" and "Xen's null scheduler" available as a per-vCPU option, with the difference that the rest of the scheduling work is delegated to ArceOS rather than written from scratch.

### The vCPU run loop (the central mechanism)

`vcpu_run()` in `axvisor/src/vmm/vcpus.rs:432` is where everything ties together. It is the equivalent of Xen's `vmx_vmexit_handler` plus the run-resume bookkeeping around it, expressed as an ordinary Rust task loop:

```rust
fn vcpu_run() {
    let curr = axtask::current();
    let vm   = curr.as_vcpu_task().vm();
    let vcpu = curr.as_vcpu_task().vcpu.clone();

    wait_for(vm_id, || vm.running());   // wait until VM is booted
    mark_vcpu_running(vm_id);

    loop {
        match vm.run_vcpu(vcpu_id) {
            Ok(exit_reason) => match exit_reason {
                AxVCpuExitReason::Hypercall { nr, args } => { /* hvc dispatch */ }
                AxVCpuExitReason::ExternalInterrupt { vector } => {
                    axhal::irq::irq_handler(vector as usize);
                    super::timer::check_events();
                }
                AxVCpuExitReason::Halt          => wait(vm_id),
                AxVCpuExitReason::CpuUp { target_cpu, entry_point, arg } => {
                    vcpu_on(vm.clone(), target_vcpu_id, entry_point, arg);
                }
                AxVCpuExitReason::SendIPI { … }     => vm.inject_interrupt_to_vcpu(…),
                AxVCpuExitReason::SystemDown        => vm.shutdown().unwrap(),
                AxVCpuExitReason::Nothing           => {}
                _                                    => warn!(…),
            },
            Err(err) => vm.shutdown().unwrap(),
        }

        if vm.suspending() { wait_for(vm_id, || !vm.suspending()); continue; }
        if vm.stopping()  { /* drain, exit loop */ break; }
    }
}
```

Key properties:

- **No arch-specific code in this loop.** All architecture-specific vmexit handling is inside `vm.run_vcpu()` (which is `axvcpu`'s job) and the exit reasons surface as a clean enum. AxVisor proper deals with the *meaning* of exits, not their hardware encoding.
- **Halt is just sleep.** `AxVCpuExitReason::Halt` calls `wait(vm_id)` which blocks on an ArceOS wait queue. When something wakes the wait queue (an IPI, a timer, a CpuUp request), the loop re-runs the vCPU. There is no special "hypervisor idle" path — halted vCPUs are just sleeping tasks.
- **Suspend/stop are checked in the same loop.** Whoever wants to suspend or stop a VM sets a flag on `vm`; the next iteration of the loop notices and either parks (suspend) or exits (stop). Cooperative shutdown, no async IPI machinery.

### Per-pCPU virtualization enable

`hal::enable_virtualization` in `axvisor/src/hal/mod.rs:120` runs at boot, spawning one thread per pCPU to enable VMX/SVM/EL2 locally:

```rust
for cpu_id in 0..cpu_count {
    thread::spawn(move || {
        ax_set_current_affinity(AxCpuMask::one_shot(cpu_id));
        vmm::init_timer_percpu();
        let percpu = unsafe { AXVM_PER_CPU.current_ref_mut_raw() };
        percpu.init(this_cpu_id()).unwrap();
        percpu.hardware_enable().unwrap();
    });
}
```

The pattern is illustrative: per-pCPU initialization is just per-task code with affinity. No special per-CPU init phase in the hypervisor — ArceOS's task spawning + affinity setting is enough.

## Memory virtualization

Implementation is in the `axaddrspace` crate (not in the axvisor repo). What axvisor does is *integrate* it with ArceOS's allocator. The relevant glue:

**`AxMmHal` implementation** (`axvisor/src/hal/mod.rs:85`):

```rust
impl AxMmHal for AxMmHalImpl {
    fn alloc_frame()   -> Option<HostPhysAddr> { … }
    fn dealloc_frame(p)                        { … }
    fn phys_to_virt(p) -> HostVirtAddr         { … }
    fn virt_to_phys(v) -> HostPhysAddr         { … }
}
```

`AxMmHal` is the trait the `axaddrspace` crate uses to get host frames; AxVisor implements it on top of ArceOS's `axalloc::global_allocator()` and `axhal::mem::virt_to_phys`. The Stage-2 / EPT walking, IPA→PA translation, page-table management — all of that lives in `axaddrspace` and `page_table_multiarch`, both consumed as crates.

**Memory allocation per VM** (`axvisor/src/vmm/config.rs:246`):

```rust
fn vm_alloc_memorys(vm_create_config: &AxVMCrateConfig, vm: &VM) {
    for memory in &vm_create_config.kernel.memory_regions {
        match memory.map_type {
            VmMemMappingType::MapAlloc     => vm.alloc_memory_region(layout, Some(gpa)),
            VmMemMappingType::MapIdentical => vm.alloc_memory_region(layout, None),
            VmMemMappingType::MapReserved  => vm.map_reserved_memory_region(layout, Some(gpa)),
        }
    }
}
```

Three modes per region: **MapAlloc** (allocate fresh host pages, map to specified GPA), **MapIdentical** (allocate fresh host pages, map them at the same GPA as their HPA — the "let the loader pick" case), **MapReserved** (use a pre-reserved physical range, don't allocate).

The [§05](/virtualization/memory/) features AxVisor explicitly does not implement: no ballooning, no overcommit machinery, no demand allocation via EPT-fault, no page sharing, no live migration. Static partition with three placement strategies.

## I/O virtualization

AxVisor leans heavily on the `axdevice` crate, which provides the virtual-device framework, and on ArceOS's host driver stack. The patterns:

**Full virtualization via `axdevice`.** Each VM has a virtual device tree (vMMIO regions registered in the VM's Stage-2 PT as fault-on-access); when the guest accesses one, the EPT/Stage-2 fault surfaces in `axvcpu` as an MMIO exit, dispatched to the registered device handler. The device implementations themselves (virtual GIC, virtual timer, virtual UART) live in `axdevice` + per-device crates.

**Passthrough.** Configured per-VM in TOML:

```toml
[devices]
passthrough_devices = [ ["/",] ]
passthrough_addresses = [ [0x28041000, 0x100_0000] ]
```

For a passed-through device, AxVisor maps the device's MMIO BARs directly into the guest's Stage-2 PT, and routes the device's interrupts to the owning vCPU via ArceOS's IRQ dispatcher.

**Host drivers** in `axvisor/src/driver/` (block, serial, SoC-specific): these are real-hardware drivers running in the AxVisor binary, exposed to virtual devices via the `axdevice` framework. The supported set is broad — Rockchip RK3568/RK3588 clk + SD/MMC + power management, Phytium MCI block, ARM GIC, x86_64 APIC — reflecting the board-bringup focus of the project.

There is no qemu-dm equivalent and no Xen-style PV split-driver model. Backends are either inside AxVisor (using ArceOS drivers) or the device is passed through whole.

## Cross-domain communication — hypercalls, IVC, and inject

Three mechanisms.

### 1. Guest → AxVisor hypercalls (`axvisor/src/vmm/hvc.rs`)

A small ABI, defined in the sibling `axhvc/` crate. The integration point is `HyperCall::execute()` in `axvisor/src/vmm/hvc.rs:44`:

```rust
pub fn execute(&self) -> HyperCallResult {
    match self.code {
        HyperCallCode::HIVCPublishChannel       => { … }
        HyperCallCode::HIVCUnPublishChannel     => { … }
        HyperCallCode::HIVCSubscribChannel      => { … }
        HyperCallCode::HIVCUnSubscribChannel    => { … }
        _ => ax_err!(Unsupported),
    }
}
```

Notable: the only hypercalls AxVisor currently implements are **IVC channel publish/subscribe**. No domain-lifecycle hypercalls (`xl create` doesn't exist — VM definitions are baked in at build time or loaded from filesystem at boot), no memory-management hypercalls (memory is statically allocated), no scheduler hypercalls (cooperative yield is just `AxVCpuExitReason::Halt`).

### 2. Inter-VM communication channels (`axvisor/src/vmm/ivc.rs`)

A publish-subscribe shared-memory channel system between VMs:

- **Publisher** calls `HIVCPublishChannel(key, *out_gpa, *out_size)`. AxVisor allocates shared memory, maps it into the publisher's Stage-2 PT at a new GPA, records `(vm_id, key) → (host_pages, size)` in a global registry, writes back the assigned GPA and size.
- **Subscriber** in another VM calls `HIVCSubscribChannel(publisher_vm_id, key, *out_gpa, *out_size)`. AxVisor looks up the channel, allocates a Stage-2 mapping of the same host pages into the subscriber's address space, writes back the GPA.

This is structurally similar to Xen's grant-table-plus-event-channel pattern, simplified: there's authorization (only the publisher can publish; channels are keyed; explicit subscribe), but no per-page granularity (channels are whole-region) and no built-in notification mechanism (consumers poll or use other mechanisms to know when data is ready).

### 3. AxVisor → guest interrupt injection (`axvisor/src/hal/mod.rs:78`)

```rust
fn inject_irq_to_vcpu(vm_id: usize, vcpu_id: usize, irq: usize) -> AxResult {
    vmm::with_vm_and_vcpu_on_pcpu(vm_id, vcpu_id, move |_, vcpu| {
        vcpu.inject_interrupt(irq).unwrap();
    })
}
```

Wrapped by `axvisor_api`'s extern-trait surface so other crates (especially virtual device implementations in `axdevice`) can inject interrupts without depending on AxVisor directly. The mechanism: queue the interrupt against the target vCPU's pending-interrupt bitmap; on the next entry into that vCPU, `axvcpu` injects it via the architecture's interrupt-injection mechanism (VMCS interrupt-info field on Intel, virtual GIC list register on ARM).

## VM management

Three layers, all visible in the source tree.

### Build-time: configs compiled in

`build.rs` plus TOML configs in `configs/vms/` get pre-processed at build time into a `vm_configs.rs` file:

```rust
// src/vmm/config.rs:127
include!(concat!(env!("OUT_DIR"), "/vm_configs.rs"));
```

`config::static_vm_configs()` returns a `Vec<&'static str>` of TOML config strings baked into the binary. Building with `cargo xtask build` after `cargo xtask defconfig <board>` picks which configs are included.

### Boot-time: VM initialization

`vmm::init()` in `axvisor/src/vmm/mod.rs:56`:

```rust
pub fn init() {
    config::init_guest_vms();   // create VM structs from configs
    for vm in vm_list::get_vm_list() {
        vcpus::setup_vm_primary_vcpu(vm);   // spawn primary vCPU task per VM
    }
}
```

`init_guest_vms` (in `axvisor/src/vmm/config.rs:141`) walks the configs (filesystem-first if `fs` feature is enabled, otherwise baked-in static), and for each one calls `init_guest_vm` which:

1. Parses the TOML into an `AxVMCrateConfig`.
2. Creates a `VM::new(vm_config)` via `axvm::AxVM::new`.
3. Allocates memory regions per the config.
4. Loads the kernel image (via `ImageLoader` — supports memory-embedded or filesystem-loaded).
5. Calls `vm.init()` for arch-specific setup.
6. Marks the VM as `Loaded` (not yet running).

The primary vCPU for each VM gets spawned as a blocked ArceOS task; secondary vCPUs come up later via `CpuUp` exits.

### Runtime: vmm::start + shell

`vmm::start()` boots every loaded VM (calls `vm.boot()`, notifies the primary vCPU's wait queue), then **waits until all VMs have stopped** before returning. When it does return, `shell::console_init()` takes over — a UART-based interactive shell with command history (`axvisor/src/shell/mod.rs:34`). The shell commands live in `axvisor/src/shell/command/`.

This means AxVisor has two execution modes in one binary:
- During VM-runtime, vCPU tasks run guests; the main task sleeps on a wait queue.
- After all VMs exit, the shell runs in the main task; users can presumably create new VMs or inspect state.

No `dom0` is needed because *the shell is in the hypervisor's binary*. Management policy lives in the same address space as the privileged code.

### What's not implemented

- **No live migration.** Static memory partition + no save/restore framework.
- **No dynamic VM creation via hypercall.** All VMs come from compiled-in TOML or from filesystem TOML at boot.
- **No event subscription / observability API.** The shell is the management surface.
- **No HA / replication.** Single-host only.

## Multi-arch portability

Supported: aarch64, x86_64, riscv64 (per README). Verified on QEMU plus Orange Pi 5 Plus, Phytium Pi, RK3568/RK3588, EVM3588.

Arch-specific code in axvisor itself is small — `axvisor/src/hal/arch/{aarch64,x86_64}/` (about 200 LoC each). The actual arch work (vmexit decoding, VMCS/VMCB management, Stage-2 / EPT walking, GIC/APIC virtualization) is in the sibling crates `axvcpu/`, `axaddrspace/`, plus the external `axplat-*` crates. The arch dispatch in axvisor uses `#[cfg_attr(target_arch = "…", path = "…")]` to pick the right HAL submodule — the same canonical-short-name layout the survey [§02](/virtualization/taxonomy/) SPEC R6 recommends.

Arch dependencies in Cargo.toml:

```toml
[target.'cfg(target_arch = "aarch64")'.dependencies]
aarch64-cpu-ext = "0.1"
arm-gic-driver = { version = "0.17", features = ["rdif"] }

[target.'cfg(target_arch = "x86_64")'.dependencies]
axplat-x86-qemu-q35 = { … }
axconfig = { features = ["plat-dyn"] }
```

Notably, RISC-V support is present in the configs (Linux/NimbOS RISC-V images, riscv64 in `vcpu_on`'s code path) but the README lists primarily ARM and x86 boards as production-tested.

## Supported guests

| Guest | Type | Use |
|---|---|---|
| ArceOS | Unikernel | Run an ArceOS instance as a guest on top of an ArceOS-hosted hypervisor (recursive!) |
| Starry-OS | Macrokernel | Real-time embedded workloads |
| NimbOS | RTOS | POSIX-ish minimal Unix-like |
| Linux | Macrokernel | General-purpose |

The Linux support in particular is significant — it means axvisor can host an unmodified mainline Linux as a `domU`-equivalent, using full hardware virtualization (VT-x/AMD-V/EL2) plus virtual devices from `axdevice`.

## Configuration model — TOML, two-layer

Two TOML hierarchies:

**Hardware platform configs** (`configs/board/*.toml`): describe the *host*, picked at build time via `cargo xtask defconfig <board>`. Example `qemu-aarch64.toml`:

```toml
cargo_args = []
features    = ["ept-level-4", "axstd/bus-mmio", "dyn-plat"]
log         = "Info"
target      = "aarch64-unknown-none-softfloat"
to_bin      = true
vm_configs  = []
```

**Guest configs** (`configs/vms/*.toml`): describe each *guest VM*, named `<os>-<arch>-<board_or_cpu>-smp<N>.toml`. Example `arceos-aarch64-qemu-smp1.toml`:

```toml
[base]
id = 1
name = "arceos-qemu"
vm_type = 1                  # full virt (paravirt would be 0)
cpu_num = 1
phys_cpu_ids = [0]

[kernel]
entry_point = 0x8020_0000
image_location = "memory"
kernel_path = "path/arceos-aarch64-dyn-smp1.bin"
kernel_load_addr = 0x8020_0000
dtb_load_addr = 0x8000_0000
memory_regions = [
  [0x8000_0000, 0x4000_0000, 0x7, 1],   # 1 GB MAP_IDENTICAL
]

[devices]
passthrough_devices = [ ["/",] ]
```

The xtask workflow (`cargo xtask defconfig` / `menuconfig` / `build`) is modeled on Linux's kbuild. The TOML configs become Rust constants at build time, baked into the binary; the binary then either boots those VMs directly or (with `fs` feature enabled) looks for additional configs in `/guest/vm_default/` at runtime.

## Source map

The AxVisor stack in this repo is checked out as eight sibling submodules under `resources/systems/axvisor/`:

```text
resources/systems/axvisor/
├── axvisor/                              — the integration binary (2.0 MB)
│   ├── src/
│   │   ├── main.rs              (55 LoC)  — 5-line main: enable_virt → init → start → shell
│   │   ├── logo.rs              (51 LoC)
│   │   ├── task.rs              (57 LoC)  — VCpuTask: TaskExt impl on TaskInner
│   │   ├── hal/
│   │   │   ├── mod.rs          (291 LoC)  — AxVMHal / AxMmHal / AxVCpuHal impls; enable_virtualization
│   │   │   └── arch/{aarch64,x86_64}/     — per-arch hardware-check, cache ops, IRQ inject
│   │   ├── vmm/
│   │   │   ├── mod.rs          (155 LoC)  — VM/VMRef/VCpuRef type aliases; init, start, with_vm
│   │   │   ├── vcpus.rs        (599 LoC)  — vcpu_run loop, vcpu_on, wait-queue infra
│   │   │   ├── config.rs       (271 LoC)  — TOML parse, vm_alloc_memorys, init_guest_vm
│   │   │   ├── hvc.rs          (162 LoC)  — Hypercall dispatch (currently IVC-only)
│   │   │   ├── ivc.rs          (299 LoC)  — Inter-VM channel publish/subscribe
│   │   │   ├── timer.rs        (127 LoC)  — Per-pCPU timer events; register/cancel
│   │   │   ├── vm_list.rs      (127 LoC)  — Global VM registry
│   │   │   ├── images/                    — Kernel image loading (memory / filesystem)
│   │   │   └── fdt/                       — aarch64 FDT/DTB cache + manipulation
│   │   ├── shell/                         — Interactive shell + commands
│   │   └── driver/                        — Host driver wrappers (block, serial, SoC)
│   ├── configs/
│   │   ├── board/                         — Hardware platform configs (host-side)
│   │   └── vms/                           — Guest VM configs (.toml + .dts)
│   ├── xtask/                             — Build-system extension (defconfig, menuconfig, build)
│   └── build.rs                           — Compile-time VM config preprocessing
│
├── axvm/                  (208 KB)        — VM lifecycle: AxVM, AxVMConfig, AxVMPerCpu
├── axvcpu/                (124 KB)        — vCPU abstraction, AxVCpuExitReason, run-loop primitives
├── axaddrspace/           (208 KB)        — guest physical addrs, Stage-2 / EPT / G-stage page tables
├── axdevice/              (104 KB)        — virtual device framework
├── axdevice_base/          (88 KB)        — base traits for virtual devices
├── axhvc/                  (84 KB)        — hypercall ABI definitions (HyperCallCode enum)
└── axvisor_api/           (156 KB)        — extern-trait API surface (lets crates call into the hypervisor without circular deps)
```

The eighth dependency is **ArceOS itself**, consumed as a crates.io dependency (`axstd` with the `hv` feature) rather than as a submodule. ArceOS provides the unikernel runtime: scheduler, allocator, paging, IRQ, console, multitask, SMP. To browse ArceOS source, see [arceos-org/arceos](https://github.com/arceos-org/arceos) on GitHub.

## Relationship to Astervisor

AxVisor is the *closest single existing system to what Astervisor wants to be*, particularly in its layering decision. The shape comparison:

| Choice | AxVisor | Astervisor (planned) |
|---|---|---|
| Layered on a Rust kernel framework? | **Yes — ArceOS unikernel** | **Yes — OSTD framekernel** |
| Hypervisor is an application of that framework? | Yes — `main()` is an axstd app | Yes — `visor/` is an OSTD app |
| TCB includes the underlying framework? | Yes (ArceOS) | Yes (OSTD) |
| Isolation boundary | Hardware (Stage-2 PT, deprivileging) | Language (Rust type system) |
| Scheduler | ArceOS task scheduler (free) | Round-robin in visor (Phase 2+) |
| Guest interface | Full virt + paravirt I/O | Cooperating Rust guests only |
| Hardware support | VT-x/SVM/EL2 + EPT/Stage-2 mandatory | Minimal — MMU + privilege rings |
| Domain-lifecycle hypercalls | None — VMs baked in at build | Yes — control-domain calls into visor |
| `unsafe` discipline | Idiomatic Rust; uses `unsafe` freely | `#![deny(unsafe_code)]` in visor |

The **architectural lesson Astervisor should take from AxVisor**: building a hypervisor as an application of a Rust kernel framework is *not just feasible but elegant*. AxVisor's `main.rs` is 5 lines because all the kernel work — scheduling, paging, IRQ, allocator, multitask, console — is already done by ArceOS. The hypervisor proper is the integration glue plus the vmexit-dispatch loop.

Translated to Astervisor's design space:

- **Astervisor's visor should be an OSTD application**, the same way AxVisor is an ArceOS application. The unsafe TCB is OSTD; the visor is safe Rust above it.
- **vCPUs as OSTD tasks** is a viable scheduling strategy — if OSTD's task abstraction can be extended with a `TaskExt` analogous to ArceOS's, the hypervisor scheduler problem reduces to "spawn one task per vCPU and let OSTD's scheduler handle the rest". This is how Phase 1's "round-robin scheduler" could be effectively free.
- **Config-driven baked-in domains** is a Phase 1-shaped choice. AxVisor shows you can ship a useful hypervisor with no domain-creation hypercall at all, as long as the build system can express the domain set.
- **A single binary with hypervisor + shell** removes the need for a separate dom0 — at the cost of putting the shell in the privileged binary. For Astervisor's language-isolation premise this is the wrong choice (the shell should be a domain), but the architecture clearly demonstrates the principle: management code does not need to live in a separate Linux guest.

The **largest divergence** is the isolation boundary. AxVisor commits to hardware isolation through-and-through (it can run unmodified Linux because of VT-x/EPT); Astervisor commits to language isolation and pays the price of "no unmodified guests, ever". AxVisor's architecture would not change much if you forced it to drop hardware-assisted virtualization — it would simply stop working, because the entire `axvcpu` mechanism is built on VMX/SVM/EL2. Astervisor's architecture is structured so that hardware-assisted virtualization is *optional*, used as defense-in-depth rather than as the primary isolation mechanism.

## What this teaches that hvisor and Xen don't

Reading AxVisor against [hvisor](/virtualization/systems/hvisor/) and [Xen](/virtualization/systems/xen/) answers questions the other two don't:

- **What does a hypervisor-on-a-Rust-OS look like architecturally?** AxVisor — and the answer is "5-line main, vCPUs are tasks, scheduler is the host kernel's".
- **How small can a hypervisor's integration layer be?** ~2 KLoC of axvisor for the orchestration, with the actual hypervisor mechanisms in 6 external crates totaling much more, but each independently versioned and reusable.
- **What does build-time-only domain configuration look like?** AxVisor's `xtask` + TOML model — no runtime hypercall surface for VM creation, no `xl` equivalent, just the build-system extension.
- **How do per-pCPU init phases compose with multitasking?** AxVisor's `enable_virtualization` spawns one thread per pCPU with affinity, lets each enable VMX/SVM locally, joins via an atomic counter. No special bootstrap dance — just multitasking with affinity.
- **Can a single binary host a hypervisor and a management shell?** AxVisor — yes, with the shell as a fallback task that runs after VMs exit.

These are the modern-Rust-hypervisor architecture decisions that hvisor (which is its own kernel) and Xen (which is a 600 KLoC C codebase with a Linux dom0) don't make. AxVisor is the cleanest demonstration of the "framework + application" approach to building a hypervisor in Rust.
