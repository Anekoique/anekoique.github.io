---
date: '2026-06-27T16:00:00+08:00'
draft: false
title: 'Virtualization Systems — QEMU'
slug: 'qemu'
tags: ["Virtualization", "Hypervisor", "Systems", "QEMU", "Emulation"]
series: ["Virtualization Series"]
summary: "The universal machine emulator and userspace half of every major Type-2 stack: TCG binary translator, QOM/qdev frameworks, accelerator interface, block layer, live migration, QMP. Why QEMU is best read as composable frameworks, not a hypervisor."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

QEMU (Quick EMUlator) is a **machine emulator** that became, by way of acquiring an accelerator interface, the canonical userspace VMM. Published at USENIX 2005 by Fabrice Bellard ([QEMU, a Fast and Portable Dynamic Translator](https://www.usenix.org/conference/2005-usenix-annual-technical-conference/qemu-fast-and-portable-dynamic-translator) (Bellard, USENIX ATC 2005)) as a *portable dynamic translator* — a cross-architecture binary translation engine fast enough to run real operating systems entirely in userspace. The KVM accelerator interface arrived in 2007, Xen support shortly after, and QEMU's identity bifurcated: simultaneously a pure software emulator and the userspace half of every major Type-2 stack. Upstream tree at `git.qemu.org/qemu.git` is ~1.5 MLoC of mostly C, supporting ~30 guest architectures, ~10 host architectures, and ~5 acceleration backends.

What makes QEMU different from the other systems in this directory is that **QEMU is not a hypervisor**. The hypervisor function is one of several things QEMU can be configured to delegate to. Reading QEMU through the §02–§08 hypervisor template distorts what it actually is; the right frame is *frameworks* that compose into different products depending on which entry point is built.

This note is structured for learning:

1. **Identity** — what QEMU is, the dual identity, consumer landscape
2. **§03 anatomy mapped to QEMU** — the bridge between this note and the rest of the survey
3. **QOM** — the substrate everything builds on
4. **MemoryRegion + qdev** — the address-space tree and device framework
5. **Accelerator framework** — the design boundary
6. **TCG** — the binary translator (self-contained; can be skipped on first read)
7. **System-mode composition** — main loop, machines, BIOS
8. **User-mode** — the other product
9. **Migration, block, QMP** — userspace-only frameworks
10. **Relationships** — to KVM, to the traditional VMM framework, to Astervisor

Source citations name canonical paths (`accel/`, `hw/`, `target/`, `tcg/`, `qom/`, `softmmu/`, `migration/`, `block/`). No pinned commit — file paths are stable but line numbers shift; they're omitted.

## 1. Identity

### Dual identity

QEMU has two distinct identities that the same codebase supports simultaneously:

- **Machine emulator** (TCG, software-only): runs a complete virtual machine entirely in userspace via dynamic binary translation. Guest can be a *different* architecture from host (ARM Linux on x86, RISC-V kernel on x86). No hardware virtualization needed; no kernel module needed.
- **Userspace VMM** (KVM/Xen/HVF/WHPX accel): the device-model and control-plane half of a hardware-assisted hypervisor. CPU and memory work is delegated to the accelerator; QEMU provides virtual chipset, BIOS, image loading, snapshots, migration.

Same binary, configured at startup with `-accel tcg` or `-accel kvm`. **The accelerator is a plug-in, not a property of QEMU itself.**

### Build targets

`./configure --target-list=` produces a different binary family per architecture:

| Target form | Binary | Purpose |
|---|---|---|
| `<arch>-softmmu` | `qemu-system-<arch>` | **System-mode**: full machine emulation — CPU + chipset + RAM + devices + BIOS |
| `<arch>-linux-user` | `qemu-<arch>` | **User-mode Linux**: run a single foreign-arch Linux ELF binary, translating syscalls |
| `<arch>-bsd-user` | `qemu-<arch>` | Same, for BSD hosts |

System-mode and user-mode share TCG, QOM, and the per-target front-end; they differ in everything above the CPU.

### Consumer landscape

| Consumer | Mode | Accel | Distinctive use |
|---|---|---|---|
| Cloud VMM (OpenStack, libvirt, Proxmox) | System | KVM | Full-featured machine emulation; the default cloud picture |
| Embedded developer | System | TCG | Boot ARM/MIPS/RISC-V kernels on x86 dev machine; no real hardware needed |
| Kernel developer (syzkaller, CI) | System | TCG or KVM | Reproducible boot for kernel tests |
| Cross-compile / `binfmt_misc` | User | (TCG only) | Docker `buildx` multi-arch, Debian `qemu-user-static` |
| Wine / Box64 / FEX-Emu baseline | User | (TCG only) | x86-on-ARM portability baseline |

---

## 2. §03 anatomy mapped to QEMU

The survey's [§03](/virtualization/vmm-architecture/) anatomy chapter names six recurring components in every VMM. Locating each one in QEMU is the fastest way to port between this note and the rest of the survey.

| §03 component   | In QEMU                                                         | Concretely                                                                                                                    |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Control plane   | QMP + machine init                                              | JSON-RPC over Unix socket, schema-generated from `qapi/`; `system/vl.c::main()` orchestrates startup                          |
| vCPU model      | `CPUState` (QOM type, per-target subclass) + accelerator vtable | `CPUState` holds vCPU state; the accelerator's `cpu_exec_loop` is what *runs* the vCPU (TCG JIT loop or `KVM_RUN` ioctl)      |
| Memory model    | `MemoryRegion` + `AddressSpace` tree                            | Per-CPU and per-DMA-master address spaces; flatten step renders to KVM memslots / TCG soft-MMU                               |
| Device model    | qdev devices (~300)                                             | Each device is a QOM type inheriting `DeviceState`, plugged into a `BusState`                                                 |
| Interrupt/timer | `qemu_irq` + per-arch irqchip                                   | `qemu_irq` is a typed link between source and sink; arch-specific irqchips (APIC, GIC, PLIC) are qdev devices                 |
| Exit handler    | Accelerator's exit dispatch                                     | KVM accelerator: switch on `kvm_run->exit_reason` and route to `address_space_rw`. TCG: `cpu_exec()` returns to C between TBs |

Two structural notes worth internalizing before any code reading:

- **Almost everything in QEMU is a QOM object.** Devices, machines, accelerators, CPUs, character devices, block backends, even MemoryRegions are QOM-adjacent. The §03 components above are all QOM types; learning QOM is learning how to navigate them.
- **The split with KVM is along the §03 components.** vCPU model + memory model + exit handler live below the boundary (in the kernel module). Control plane + device model + most of the interrupt/timer model live above (in QEMU). See §10.

---

## 3. QOM — the object system

QOM (QEMU Object Model) is the type/object system every QEMU subsystem builds on. Reading non-trivial QEMU code without understanding QOM is futile.

QOM is a C-implemented runtime object system with single inheritance, interface mixins, properties, and reference counting. Modeled loosely on GObject but deliberately lighter; GObject was rejected as too heavyweight, C++ as too portable-fragile. Code in `qom/`, headers in `include/qom/`.

It gives QEMU four things plain C does not:

- **Inheritance** — `VirtIONetPCI` is-a `PCIDevice` is-a `DeviceState` is-a `Object`.
- **Virtual dispatch** — `realize()`, `reset()`, MMIO ops, migration callbacks are overridable per concrete type.
- **Runtime reflection** — QMP can enumerate every device, set any property by name, list every type. `-device foo,bar=42` works uniformly because there's a property surface.
- **Composition** — the QOM tree (machine → chipset → buses → devices) is itself a typed object graph that's introspectable.

### The four core structures

**`TypeInfo` — static declaration.** Written at module scope, one per type:

```c
typedef struct TypeInfo {
    const char *name, *parent;
    size_t instance_size, class_size;
    void (*instance_init)(Object *obj);
    void (*instance_finalize)(Object *obj);
    void (*class_init)(ObjectClass *klass, const void *data);
    bool abstract;
    InterfaceInfo *interfaces;     // NULL-terminated
    /* ... */
} TypeInfo;
```

**`TypeImpl` — runtime form.** When a `TypeInfo` is registered, QOM copies its fields into a `TypeImpl` held in a global hash table keyed by name. `TypeImpl` adds the resolved `parent_type`, the lazily-allocated `class`, and resolved interface impls. The rest of QOM operates on `TypeImpl`, not `TypeInfo`.

**`ObjectClass` — per-type singleton.** One per registered type, holds the vtable. Subclasses extend by being structs whose first field is the parent class:

```c
struct ObjectClass {  Type type; GHashTable *properties; /* ... */ };

struct DeviceClass {
    ObjectClass parent_class;      // ← first field
    DeviceRealize realize;
    const VMStateDescription *vmsd;
    /* ... */
};

struct PCIDeviceClass {
    DeviceClass parent_class;      // ← first field
    void (*realize)(PCIDevice *dev, Error **errp);
    uint16_t vendor_id, device_id;
    /* ... */
};
```

**`Object` — per-instance struct.** Carries `class` (vtable pointer), refcount, instance-property hash, parent pointer:

```c
struct Object { ObjectClass *class; GHashTable *properties; uint32_t ref; Object *parent; };

struct DeviceState { Object parent_obj; char *id; bool realized; BusState *parent_bus; /* ... */ };
struct PCIDevice   { DeviceState qdev; uint8_t *config; /* ... */ };
```

### The pointer-equivalence trick

The "first field is parent" idiom is the *entire* mechanism of QOM inheritance. At offset 0x0, `(ObjectClass *)`, `(DeviceClass *)`, `(PCIDeviceClass *)` all point to the same memory. Casts traverse the chain at zero runtime cost; cast macros (`DEVICE_CLASS(klass)`, `PCI_DEVICE(obj)`) wrap a debug-mode runtime check (`object_class_dynamic_cast_assert`).

### Type registration before `main()`

Types register via GCC's `constructor` attribute. `type_init(register_func)` expands to:

```c
static void __attribute__((constructor)) do_qemu_init_##fn(void) {
    register_module_init(fn, MODULE_INIT_QOM);
}
```

`register_module_init` appends `fn` to a linked list in `init_type_list[MODULE_INIT_QOM]` (in `utils/module.c`). Early in `main()`, `module_call_init(MODULE_INIT_QOM)` walks the list, invoking each function. Each calls `type_register_static`, which copies the `TypeInfo` into a `TypeImpl` and inserts it in the hash table.

**Two-stage init is critical.** Registration is unordered (link order). Class initialization (next section) respects parent chains and is lazy. This split lets a child mention its parent by string name without ordering constraints.

### Class initialization, in dependency order

`type_initialize(ti)` runs the first time anyone resolves a class. It walks the parent chain root-to-leaf:

```c
static void type_initialize(TypeImpl *ti) {
    if (ti->class) return;                              // already done

    ti->class_size    = type_class_get_size(ti);
    ti->instance_size = type_object_get_size(ti);
    ti->class         = g_malloc0(ti->class_size);

    TypeImpl *parent = type_get_parent(ti);
    if (parent) {
        type_initialize(parent);                        // recurse
        memcpy(ti->class, parent->class, parent->class_size);   // inherit vtable defaults
        /* propagate parent's interfaces; initialize this type's own interfaces */
    }
    ti->class->properties = g_hash_table_new_full(...);
    ti->class->type = ti;

    /* run ancestors' class_base_init (rarely used), then ti->class_init */
    if (ti->class_init) ti->class_init(ti->class, ti->class_data);
}
```

The `memcpy(ti->class, parent->class, parent->class_size)` is how virtual-method *defaults* inherit: the child's class buffer starts as a byte-for-byte copy of the parent's vtable; `class_init` then selectively overrides. There is no "super.method()" mechanism — the child's class struct *is* a copy-on-write extension of the parent's at the memory level.

A concrete `class_init`:

```c
static void edu_class_init(ObjectClass *klass, const void *data) {
    DeviceClass    *dc = DEVICE_CLASS(klass);          // parent vtable view
    PCIDeviceClass *k  = PCI_DEVICE_CLASS(klass);      // PCI-class view
    k->realize    = pci_edu_realize;
    k->vendor_id  = PCI_VENDOR_ID_QEMU;
    k->device_id  = 0x11e8;
    dc->desc      = "PCI educational device";
}
```

### Instance creation, in dependency order

```
object_new(name) → object_new_with_type → object_initialize_with_type → object_init_with_type
```

`object_init_with_type` recursively calls each ancestor's `instance_init` root-to-leaf:

```c
static void object_init_with_type(Object *obj, TypeImpl *ti) {
    if (type_has_parent(ti)) object_init_with_type(obj, type_get_parent(ti));
    if (ti->instance_init)   ti->instance_init(obj);
}
```

The full sequence for `object_new("edu")`: resolve `TypeImpl` (lazy-init the class chain on first use); allocate `instance_size` zeroed; set `obj->class`; walk ancestors root-to-leaf calling `instance_init` (object → device → pci → edu); run `instance_post_init`; return.

`object_new` does **not** make the device usable. The lifecycle is `construct → configure → realize`:

```
object_new() → instance_init()   ← inert; properties exist but device is unconnected
              │
              ▼ (caller sets properties via object_property_set_*)
              │
              ▼
            realize()             ← plugged into bus, MMIO registered, IRQs wired
```

### Realize

Transition from inert to live is triggered by setting the `"realized"` property to true:

```c
bool qdev_realize(DeviceState *dev, BusState *bus, Error **errp) {
    if (bus) qdev_set_parent_bus(dev, bus, errp);
    return object_property_set_bool(OBJECT(dev), "realized", true, errp);
}
```

The setter (`device_set_realized`) walks the class hierarchy leaf-to-root calling each `DeviceClass.realize`. Realize is where the device plugs into the bus, registers MemoryRegions, wires IRQs, spawns threads. It's the failure-prone step — returns errors via `Error **errp`.

### Properties — the reflection layer

A property is a `(name, type, get, set, opaque)` tuple on a class or instance. Layout (`include/qom/object.h`):

```c
struct ObjectProperty {
    char *name, *type, *description;
    ObjectPropertyAccessor *get, *set;
    void *opaque;                  // type-specific descriptor
    QObject *defval;
};
```

Two storage levels: `ObjectClass.properties` (shared, set in `class_init`) and `Object.properties` (per-instance, set in `instance_init` or later). Both are GHashTables keyed by string.

Properties are how `-device edu,debug=on` (CLI), `qom-set /machine/peripheral/edu0 debug=on` (QMP/monitor), and migration's `VMStateDescription` reflection all share one mechanism. Declaratively via qdev:

```c
static const Property edu_properties[] = {
    DEFINE_PROP_BOOL("debug",   EduState, debug, false),
    DEFINE_PROP_UINT32("speed", EduState, speed, 100),
    DEFINE_PROP_END_OF_LIST(),
};
```

**Visitors** decouple property type from input/output format. Same setter is reachable from:

- `StringInputVisitor` (parses `"42"` from CLI)
- `QObjectInputVisitor` (reads QMP JSON tree)
- `StringOutputVisitor` / `QObjectOutputVisitor` (the reverse, for monitor and QMP responses)

### Specialized property types

Beyond scalars, three property kinds carry domain structure:

```c
typedef struct { Object **targetp; ObjectPropertyLinkFlags flags;
                 void (*check)(...); } LinkProperty;
typedef struct { char *(*get)(...); void (*set)(...); } StringProperty;
typedef struct { bool  (*get)(...); void (*set)(...); } BoolProperty;
```

**`link<T>` — composition by reference.** Typed pointer to another Object:

```c
object_property_add_link(obj, "drive", TYPE_BLOCK_BACKEND,
                         (Object **)&dev->blk,
                         qdev_prop_allow_set_link_before_realize,
                         OBJ_PROP_LINK_STRONG);
```

When CLI says `-device virtio-blk-pci,drive=mydisk`, qdev looks up `/objects/mydisk`, type-checks it, assigns the pointer. The property's type string is constructed as `g_strdup_printf("link<%s>", type)` — so `link<block-backend>`.

**Worked example — GPIO/IRQ wiring as link properties.** `qdev_init_gpio_out_named` in `hw/core/qdev.c`:

```c
for (int i = 0; i < n; ++i) {
    gchar *propname = g_strdup_printf("%s[%u]", name, gpio_list->num_out + i);
    object_property_add_link(OBJECT(dev), propname, TYPE_IRQ,
                             (Object **)&pins[i],
                             object_property_allow_set_link,
                             OBJ_PROP_LINK_STRONG);
    g_free(propname);
}
```

Each GPIO out becomes a `link<irq>` property. Board files wire GPIOs to interrupt controllers by *setting properties* — wiring is configuration, not code.

**`child<T>` — composition by ownership.** `object_property_add_child` sets `child->parent = obj`, increments refcount, makes the child addressable by canonical path (`/machine/peripheral/edu0`).

### The composition tree

Rooted at `object_get_root()`. Canonical paths look like:

```text
/
├── machine
│   ├── peripheral          ← -device with id=
│   ├── peripheral-anon     ← -device without id=
│   └── i440fx              ← chipset
│       └── pci.0           ← PCI bus
├── objects                 ← -object on CLI
│   └── mydisk              ← block backend, RNG, chardev, …
└── chardevs
```

`qom-list`, `qom-get`, `qom-set` operate on this tree. The tree is also the lifetime tree: parent refcount hits zero → child links release → `instance_finalize` runs leaf-to-root.

### Interfaces — duck typing with type safety

Some abstractions (e.g. `HotplugHandler`) cut across the inheritance tree. QOM's answer is interfaces: abstract types with `instance_size == 0` whose class declares method pointers. Implementers list them in `TypeInfo.interfaces`:

```c
.interfaces = (InterfaceInfo[]) { { TYPE_HOTPLUG_HANDLER }, { } },
```

`class_init` fills in the methods on the per-interface vtable hung off the implementing class:

```c
HotplugHandlerClass *hc = HOTPLUG_HANDLER_CLASS(klass);
hc->plug = pcie_cap_slot_plug_cb;
```

Code holding a `HotplugHandler *` calls `hotplug_handler_plug(hh, child, errp)` and dispatches via the interface vtable regardless of concrete type. Interfaces carry no state — only an extra vtable.

### Cast macros and virtual dispatch

`OBJECT_DECLARE_SIMPLE_TYPE(EduState, PCI_EDU_DEVICE)` expands to three macro families:

- **`FOO(obj)`** — `Object *` → `FooState *`. For instance-field access.
- **`FOO_CLASS(klass)`** — `ObjectClass *` → `FooClass *`. Used in `class_init` to set vtable fields.
- **`FOO_GET_CLASS(obj)`** — instance → its class. For virtual dispatch: `DEVICE_GET_CLASS(dev)->realize(dev, &err)`.

### End-to-end lifecycle

`-device edu,id=edu0,drive=mydisk`:

```
main()
  module_call_init(MODULE_INIT_QOM)            ← every type_init constructor fires;
                                                  TypeImpls live in the hash table

CLI parser → qdev_device_add():
  object_new("edu")
    → object_class_by_name lazily type_initializes object→device→pci→edu
    → allocate EduState, set ->class
    → instance_init walk: object_instance_init → device_initfn
                          → pci_device_instance_init → edu_instance_init
  object_property_add_child(/machine/peripheral, "edu0", obj)
  set "drive" link property → resolves /objects/mydisk
  set "addr" property       → PCI slot
  set "realized" = true:
    device_set_realized:
      class chain realize, leaf-to-root:
        pci_qdev_realize  → plugs into PCI bus, allocates BARs
        pci_edu_realize   → MemoryRegions, IRQ, worker thread

device_del edu0:
  DeviceClass.unrealize (leaf-to-root reverse)
  object_unparent → refcount drops → instance_finalize walk → free
```

### Patterns to recognize in any device file

- `TypeInfo` + `type_init(register_func)` — registration boilerplate.
- `OBJECT_DECLARE_SIMPLE_TYPE` in the header — cast macros + struct typedefs.
- `instance_init` cannot fail; sets up properties, sub-objects.
- `realize` returns errors; plugs into bus, allocates BARs, spawns threads.
- `class_init` fills the vtable; sets class-level property defaults.
- `DEFINE_PROP_*` + `device_class_set_props` for declarative properties.
- `object_property_add_link` / `add_child` for composition.
- `<TYPE>_GET_CLASS(obj)->method(obj, args)` for virtual dispatch.

### Reading order for the QOM source

1. `include/qom/object.h` — declarations and the property API (half a day).
2. `qom/object.c` — `type_initialize`, `object_init_with_type`, properties, dynamic cast (half a day).
3. `include/qemu/module.h` + `utils/module.c` — the `type_init` macro and `init_type_list` (15 minutes).
4. `hw/misc/edu.c` — a complete, minimal pedagogical PCI device (~400 lines).
5. `include/hw/qdev-core.h` + `hw/core/qdev.c` — qdev is short once QOM is solid.
6. `qapi/qom.json` — the QMP commands over the QOM tree.

---

## 4. MemoryRegion and qdev

These two frameworks sit directly on QOM; almost every device touches both.

### MemoryRegion — the address-space tree

`MemoryRegion` (`softmmu/memory.c`, `include/exec/memory.h`) is how guest address spaces are composed. A region can be:

| Kind | Backing |
|---|---|
| RAM | host memory (`mmap`'d) |
| MMIO | callbacks for read/write |
| ROM | read-only RAM |
| Container | holds children at offsets |
| Alias | view into another region (used for mirroring) |

An `AddressSpace` (plural because the CPU and each DMA-master have their own) flattens the region tree into a `FlatView` that KVM memslots / TCG soft-MMU consume. When a device's BAR moves, the framework re-flattens and either updates `KVM_SET_USER_MEMORY_REGION` or flushes TCG TBs.

Devices mostly do two things: change MemoryRegion mappings (register decoding) and raise/lower IRQs.

### qdev — devices on QOM + buses

A *device* in qdev is a QOM object that inherits from `DeviceState`, plugs into a `BusState`, has typed properties for configuration, and has a `realize` method. Buses enforce protocol (PCI config space, SCSI command set, USB transfer types).

Minimal example:

```c
struct FooState {
    SysBusDevice parent_obj;
    MemoryRegion mmio;
    qemu_irq irq;
    uint32_t prop_speed;
};

static void foo_realize(DeviceState *dev, Error **errp) {
    FooState *s = FOO(dev);
    memory_region_init_io(&s->mmio, OBJECT(s), &foo_ops, s, "foo", 0x1000);
    sysbus_init_mmio(SYS_BUS_DEVICE(dev), &s->mmio);
    sysbus_init_irq(SYS_BUS_DEVICE(dev), &s->irq);
}

static const Property foo_props[] = {
    DEFINE_PROP_UINT32("speed", FooState, prop_speed, 100),
    DEFINE_PROP_END_OF_LIST(),
};

static void foo_class_init(ObjectClass *klass, void *data) {
    DeviceClass *dc = DEVICE_CLASS(klass);
    dc->realize = foo_realize;
    device_class_set_props(dc, foo_props);
}

static const TypeInfo foo_info = {
    .name          = "foo",
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(FooState),
    .class_init    = foo_class_init,
};
type_init(({ type_register_static(&foo_info); }))
```

The framework provides property parsing, automatic VMState integration, resource cleanup on unrealize, monitor introspection. ~300 devices in `hw/` look mostly like this — qdev absorbs the boilerplate.

---

## 5. The accelerator framework

The accelerator is *the* design boundary that turned QEMU from emulator into VMM. Code in `accel/`.

### `AccelClass` and `AccelOpsClass`

Each accelerator is a pair of QOM classes:

- **`AccelClass`** — configuration object. `-accel <name>,<opts>` instantiates this.
- **`AccelOpsClass`** — per-vCPU vtable.

Headline interface (`include/sysemu/accel-ops.h`):

```c
struct AccelOpsClass {
    void (*create_vcpu_thread)(CPUState *cpu);
    void (*kick_vcpu_thread)(CPUState *cpu);
    int  (*cpu_exec_loop)(CPUState *cpu);              // ← the "run the guest" call
    void (*synchronize_state)(CPUState *cpu);
    void (*synchronize_post_reset)(CPUState *cpu);
    bool (*supports_guest_debug)(void);
    int  (*insert_breakpoint)(CPUState *cpu, ...);
    /* ... */
};
```

The rest of QEMU calls through `cpus_accel->cpu_exec_loop(cpu)`. Everything else is accelerator-agnostic.

### Inventory

| Accelerator | Path | Mechanism | Host requirement |
|---|---|---|---|
| **TCG** | `accel/tcg/` | In-process dynamic binary translation | None |
| **KVM** | `accel/kvm/kvm-all.c` | Linux `/dev/kvm` ioctls | Linux + `kvm.ko` |
| **Xen** | `accel/xen/xen-all.c` | Xen libxenctrl + HVM ioreq pages | Linux dom0 |
| **HVF** | `accel/hvf/` | macOS `Hypervisor.framework` | macOS + VMX/Apple Silicon |
| **WHPX** | `accel/whpx/` | Windows Hypervisor Platform | Windows + Hyper-V |
| **NVMM** | `accel/nvmm/` | NetBSD NVMM module | NetBSD |

### KVM accelerator

In `accel/kvm/kvm-all.c`. Responsibilities are tight because most work is in the kernel:

- Open `/dev/kvm`, `KVM_CREATE_VM`, register memslots
- Translate `MemoryListener` callbacks (address-space changes) into `KVM_SET_USER_MEMORY_REGION`
- Per-vCPU: create thread, `KVM_CREATE_VCPU`, `mmap` `kvm_run`, set CPUID/MSRs, loop on `KVM_RUN`
- On `KVM_RUN` return, switch on `exit_reason`; dispatch MMIO to `address_space_rw`, PIO to `cpu_inl/outl`

**Lazy state sync** is worth noting. Most of the time, `CPUState->kvm_vcpu_dirty == false` — canonical guest state lives in the VMCS, `CPUState`'s register fields are stale. When QEMU wants to read state (gdbstub, migration), `kvm_cpu_synchronize_state` calls `KVM_GET_REGS/SREGS/MSRS/...`. When QEMU wants to write, it marks dirty; the next vCPU run pushes via `KVM_SET_*`.

### TCG accelerator

Per §6 below: `create_vcpu_thread` spawns a thread that runs `cpu_exec()` in a loop; the vCPU "state" is the `CPUArchState` struct. No kernel involvement.

---

## 6. TCG — the binary translator

TCG (Tiny Code Generator) is QEMU's multi-tier JIT: takes guest instructions, produces native host instructions on demand. It is what makes QEMU a *machine emulator*. Code in `tcg/` (back-end + IR), `accel/tcg/` (execution loop, soft-MMU), `target/<arch>/translate.c` + `helper.c` (front-end).

### Pipeline

```text
guest binary
   │
   ▼  per basic block, first execution
front-end (target/<guest>/translate.c)
   │  decodes guest insn; emits TCG IR ops
   ▼
TCG IR (~150 ops, 3-address, SSA-ish)
   │  optimizer (tcg/optimize.c): constant folding, dead code,
   │                              copy propagation, liveness
   ▼
back-end (tcg/<host>/tcg-target.c.inc)
   │  lowers IR ops to host instructions; register-allocates within block
   ▼
host machine code in the translation cache (TB cache)
   │
   ▼
direct dispatch via "chained" TBs:
   end-of-TB jump patched to point at next TB's host code,
   avoiding the dispatcher entirely for hot code paths
```

Unit of translation is the **translation block** (TB) — usually a guest basic block, ending at a control-flow insn or page boundary. TBs are cached by `(guest PC, flags)` and chained.

### Front-end

`target/<arch>/translate.c` walks guest instructions and emits IR. Modern targets are decode-tree-driven: a `*.decode` file describes the instruction encoding; a generator emits the dispatch switch. For x86 `add %eax, %ebx`:

```text
t0 = ld_i32  cpu_env, offsetof(CPUX86State, regs[R_EAX])
t1 = ld_i32  cpu_env, offsetof(CPUX86State, regs[R_EBX])
t2 = add_i32 t0, t1
st_i32 t2,   cpu_env, offsetof(CPUX86State, regs[R_EBX])
;; eflags update via a deferred-flags scheme
```

`cpu_env` is a TCG-IR register holding `CPUArchState *`. Guest registers live in memory in `CPUArchState`; the back-end's register allocator keeps them in host registers within a TB.

### IR

`tcg/tcg-op.h` declares ~150 ops, host-architecture-independent:

- **Arithmetic/logical**: `add_i32`, `and_i64`, `shl_i32`, `mul_i32`, `divu_i64`, …
- **Compare-and-branch**: `brcond_i32 cond, t0, t1, label`
- **Load/store**: `ld8u_i32`, `st32_i64`, `qemu_ld_a64` (the soft-MMU load)
- **Control**: `goto_tb`, `exit_tb`, `goto_ptr`
- **Helper call**: `call helper_fn, ...` — escape hatch to C

### Helpers — the escape hatch

A helper is a C function in `target/<arch>/helper.c` that the front-end emits a call to. Used for: operations too complex to inline (FPU, MMU walks, segment loads), rare operations (CPUID, x86 string insns), side-effecting operations needing full `CPUArchState`.

`DEF_HELPER_<N>(name, ret, arg, …)` macros emit prototype + IR call sequence + JIT stub.

### Back-end

`tcg/<host>/tcg-target.c.inc` (the `.c.inc` is a longstanding QEMU idiom — included into `tcg/tcg.c` rather than compiled standalone). Supported hosts: x86_64, i386, aarch64, arm, ppc64, riscv64, s390x, mips64, sparc64, loongarch64.

Three responsibilities: register allocation (virtual → host, spilling to per-TB frame), instruction selection (per-IR-op emitter writing machine bytes), block chaining (end-of-TB jump initially to dispatcher, patched to next TB).

### Execution loop and soft-MMU

`accel/tcg/cpu-exec.c::cpu_exec()` is TCG's `KVM_RUN`:

```c
for (;;) {
    if (interrupt_pending(cpu)) handle_interrupt(cpu);
    TB *tb = tb_lookup(cpu, pc, flags);
    if (!tb) tb = tb_gen_code(cpu, pc, flags);          // JIT it
    ret = tcg_qemu_tb_exec(env, tb->tc.ptr);            // run host code
    /* returns on exception, interrupt check, syscall, unpatched chain */
}
```

**Soft-MMU** is the hardest piece: how TCG handles guest virtual addresses without hardware help. The front-end emits `qemu_ld_a64`; the back-end lowers it to:

```text
index = (guest_addr >> PAGE_BITS) & TLB_MASK
entry = TLB[mmu_idx][index]
if (entry.addr_read == (guest_addr & ~PAGE_MASK))
    // TLB hit: ~5 host insns
    load from entry.haddr + (guest_addr & PAGE_MASK)
else
    call helper_ld_mmu(env, guest_addr, …)
        // walks guest PT, fills TLB, returns value
```

QEMU maintains a software TLB per MMU index per vCPU (`CPUTLBDesc` in `include/exec/cpu-defs.h`). On miss, a helper walks the guest's *own* page tables (the front-end knows the guest's paging structure) to find host PA.

The soft-MMU is what makes TCG faithfully emulate any guest, MMU included. It also bounds TCG's performance: every guest memory access is 5+ host insns even on TLB hit. This is the *fundamental* cost of software-only virtualization that hardware-assisted nested paging removed.

### MTTCG and user-mode TCG

**MTTCG** (Multi-Threaded TCG, 2017): each vCPU is a host thread with its own TB cache lookup. Explicit memory-barrier IR ops the back-end lowers to host fences. Works when guest memory model is *weaker than or equal to* host's.

**User-mode** bypasses the soft-MMU: guest VAs are host VAs (with `mmap`-controlled placement). Syscalls become helper calls into `linux-user/syscall.c`. See §8.

### TCG vs KVM

| Concern | TCG | KVM |
|---|---|---|
| Where guest CPU runs | Translated host code | VMX non-root on a real pCPU |
| Address translation | Soft-MMU (software TLB + guest PT walker) | EPT (hardware) |
| Memory access cost | 5+ host insns/access | 1 host insn |
| Sensitive insns | Front-end emits emulation IR | VM-exit per insn |
| Cross-arch | Yes | No |
| Kernel module | None | `kvm.ko` |
| Steady-state speed | ~5–15× slower than native | Near-native |

**TCG and KVM aren't competitors.** TCG does things KVM can't (cross-arch, no kernel, instruction-level tracing); KVM does things TCG can't (full speed). QEMU supports both because both are useful.

---

## 7. System-mode composition

System-mode is where every framework above composes: QOM for objects, qdev for devices, accelerator for CPU execution, MemoryRegion for address-space layout.

### Process layout

```text
qemu-system-x86_64 process
  ├─ main loop (util/main-loop.c)  — poll fds, timers, bottom-halves, AIO
  ├─ vCPU threads — KVM: ioctl(vcpu_fd, KVM_RUN); TCG: cpu_exec()
  ├─ I/O threads — block AIO, vhost-user, VNC, monitor
  ├─ QOM tree     /machine/peripheral/*, /machine/i440fx/*, …
  ├─ AddressSpaces  cpu_memory, cpu_io, pci_address_space
  ├─ Backends     block (qcow2/raw), net (tap/socket), chardev (pty/socket)
  └─ Control plane  HMP monitor + QMP socket
```

### Machine types

A *machine type* (`hw/<arch>/`) is a recipe: CPUs, chipset, BIOS, default devices, memory layout. Key x86 examples:

| Machine | Chipset | When |
|---|---|---|
| `pc-i440fx-*` | i440FX + PIIX3 (1996-era) | Default before 2.0; legacy compat |
| `pc-q35-*` | Q35 + ICH9 + PCIe (2009-era) | Modern x86 default |
| `microvm` | Minimal: virtio-mmio + serial, no PCI, no BIOS | Firecracker-shaped microVMs |
| `virt` | ARM/RISC-V purely-virtual board (GIC + virtio-mmio) | "Boot a kernel directly" board |

The `microvm` machine is worth noting: QEMU's response to [Firecracker](/virtualization/systems/firecracker/), demonstrating QEMU *can* be made tiny (no PCI, no ACPI, no BIOS — direct PVH kernel boot) while staying QEMU.

A machine's `init` function builds the QOM tree: creates CPUs, instantiates the chipset device, attaches RAM, wires IRQs, loads BIOS/kernel. Then the main loop runs and vCPUs start.

### Device wiring trace

`-device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56`:

1. CLI parses to a QOM instantiation request
2. Find `virtio-net-pci` in the type registry
3. Create instance, set properties (`netdev = "n0"`, `mac = ...`)
4. Look up default PCI bus for the machine
5. `realize` plugs into bus (PCI config-space, BAR placement), hooks netdev backend, registers MemoryRegions into the parent bus's address space, calls `virtio_init`
6. If KVM: address-space change propagates to `KVM_SET_USER_MEMORY_REGION` and any registered ioeventfds; if vhost-net: `ioctl(vhost_fd, ...)` connects the in-kernel backend
7. If TCG: address-space change invalidates affected TBs

### Main loop and the BQL

QEMU's main loop (`util/main-loop.c`) is a glib `GMainLoop` wrapper. Most non-vCPU work funnels through here.

The subtle thing is the **BQL** (Big QEMU Lock). For decades, all device-model code, all main-loop callbacks, most monitor code held one global mutex. Modern QEMU is shrinking it (block AIO contexts, vhost, MTTCG), but BQL is still the single biggest scalability constraint in production QEMU/KVM. (This is why `dpdk` userspace data planes and `vhost` kernel data planes exist — avoid BQL on hot paths.)

### Firmware, ACPI, boot

System-mode QEMU loads firmware into the guest reset vector and hands off. On x86:

- **SeaBIOS** — open-source classical BIOS, default for `pc-i440fx-*`.
- **OVMF** — open-source UEFI (TianoCore build), default for `pc-q35-*` modern guests.

QEMU embeds these in `pc-bios/`. SeaBIOS knows about `fw_cfg` — a paravirt MMIO/IO device through which QEMU tells firmware about machine layout, ACPI tables, kernel/initrd if `-kernel`, etc.

**QEMU builds the guest's ACPI tables itself** (`hw/acpi/`) reflecting the machine's actual config (CPU count, memory map, hotplug slots, IOMMU). Firmware reads them from `fw_cfg`. This is why QEMU controls the firmware-OS interface even on UEFI guests.

---

## 8. User-mode

`qemu-x86_64`, `qemu-arm`, `qemu-riscv64` (`linux-user/`, `bsd-user/`) are a fundamentally different product. They run a single foreign-arch Linux/BSD ELF binary by translating instructions with TCG and translating syscalls to the host's.

**There is no guest kernel.** No interrupts, no MMU (guest VA = host VA via `mmap`), no devices, no scheduler. The guest is a userspace program; QEMU impersonates a Linux kernel for it.

### Syscall translation

`linux-user/syscall.c` is a ~30 KLoC switchbox. Each guest syscall: decode by number → convert struct layouts (guest `struct stat` may differ from host's) → convert pointers and endianness → invoke host syscall → convert return → map errno.

Bulk of the code is **structural divergence**: guest Linux structs/ioctl numbers/signals/errnos vary per architecture. Each must be translated. This is why user-mode QEMU is large despite having no devices.

Threads use `clone()` directly (guest thread = host thread sharing the QEMU process); signals are translated on entry/exit.

### Uses

- **Cross-compile testing**: build ARM, run under `qemu-arm` before shipping.
- **`binfmt_misc`** routing: kernel transparently invokes `qemu-<arch>-static` for foreign executables. Basis of Docker `buildx` multi-arch and Debian's `qemu-user-static`.
- **Wine, Box64, FEX-Emu** use QEMU user-mode as their portability baseline.

User-mode is *not virtualization* in any strict sense — there's no VM, only a translated process. But it's the same TCG, the same front-end, the same QOM-free portion of the codebase. The CPU translator separates cleanly from the rest; the same translator drives different products.

---

## 9. Userspace-only frameworks: migration, block, QMP

Three large subsystems share the theme **"userspace gives QEMU what the kernel cannot"**.

### Migration

`migration/` is QEMU's live-migration framework (~30 KLoC). Core is **VMState**, a declarative serialization spec registered per qdev device:

```c
static const VMStateDescription vmstate_foo = {
    .name = "foo", .version_id = 2, .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32(reg_ctrl,   FooState),
        VMSTATE_UINT32(reg_status, FooState),
        VMSTATE_UINT32_V(new_field, FooState, 2),     // added in v2
        VMSTATE_END_OF_LIST()
    },
};
```

Properties: declarative (no hand-rolled serializers), versioned (v2 source → v1 dest if v2-only fields default cleanly), per-subsection (optional state in stream only if source had it), compatibility-tested.

The engine in `migration/migration.c` orchestrates pre-copy (RAM stream + iterative dirty resend), precopy/postcopy switch, destination restore, transport (TCP/RDMA/multifd/socket exec).

The hard problem migration solves — and the reason QEMU is 1.5 MLoC — is that **every device model has to be migration-aware**. Mid-DMA disk controllers, in-flight NIC packets, virtio descriptors all need to serialize cleanly. Two decades of wringing this out. This is also why **passthrough device migration is hard**: device state lives in *its own registers*, not in QEMU.

### Block layer

`block/` (~60 KLoC) is a userspace storage stack: a tree of `BlockDriverState` objects composable into a graph between a guest virtual disk controller and a host file/block-device.

Driver inventory:

| Driver | What |
|---|---|
| `raw` | Pass-through to host file/block-device |
| `qcow2` | QEMU's COW image format: snapshots, encryption, compression, backing files |
| `qed`/`vmdk`/`vhdx`/`vdi`/`vpc` | VMware/VirtualBox/Hyper-V image compatibility |
| `iscsi`/`nbd`/`nfs`/`rbd`/`ssh`/`gluster`/`http` | Network storage |
| `luks` | LUKS encryption |
| Filters: `throttle`, `copy-on-read`, `mirror`, `backup`, `compress` | Wrap another BDS |

Composability is the point. A guest write traverses: virtio-blk frontend → device model → `BlockBackend` → `qcow2` → `throttle` → `luks` → `raw` → `/dev/nvme0n1p3`. Each layer is a separate BDS with its own AIO context. Snapshots, mirroring, live conversion — graph manipulations on this tree.

The lesson: **putting the block layer in userspace gives QEMU what the kernel cannot cheaply** — composable, file-format-aware, network-protocol-aware, hot-pluggable storage filters. Cost: every guest write traverses more code than a kernel block stack would.

### QMP

Control plane: JSON-RPC over Unix socket / TCP / stdio. HMP (the `(qemu)` prompt) is a thin shell on QMP.

QMP is generated from a JSON schema (`qapi/`) by `scripts/qapi-gen.py`. Schema declares commands, events, types; the generator emits C marshallers, dispatchers, visitor stubs. **Exhaustive and machine-readable** — every command and type is documented in the schema that doubles as the binding for libvirt's client libraries.

The QOM tree is fully QMP-introspectable: `qom-list /machine`, `qom-get /machine/peripheral/net0/mac`, `qom-set ... cache.direct=true`. Hotplug: `device_add`, `device_del`. Migration: `migrate`. Snapshots: `snapshot-save`, `snapshot-load`. Block jobs: `block-commit`, `block-mirror`.

**QEMU is fully programmable at runtime from outside**, with a schema'd protocol every cloud-management tool builds on.

---

## 10. Relationships

### To KVM — the boundary, made concrete

[KVM](/virtualization/systems/kvm/) covered the kernel side; this note's frameworks now make the userspace side visible. The split by subsystem:

| Subsystem | Owner |
|---|---|
| vCPU execution (VMX non-root) | KVM |
| Second-stage paging (EPT) | KVM |
| In-kernel LAPIC, IOAPIC, PIT | KVM |
| vhost-net, vhost-scsi | KVM-adjacent (`drivers/vhost/`) |
| Memslot registration | Boundary (ioctl) |
| irqfd / ioeventfd | Boundary |
| Memory tree, AddressSpace flattening | QEMU |
| PCI bus, chipset emulation | QEMU |
| Device models (virtio frontends, e1000, IDE, USB) | QEMU |
| BIOS / UEFI | QEMU + SeaBIOS/OVMF |
| Block layer (qcow2, network storage, snapshots) | QEMU |
| Migration engine, VMState | QEMU |
| Control plane (QMP) | QEMU |
| Machine type, ACPI table generation | QEMU |

QEMU is **everything that doesn't need ring 0**. ~30× larger than the kernel module.

### QEMU vs Firecracker — what 1.5 MLoC buys

| Feature | QEMU | Firecracker |
|---|---|---|
| Image formats | qcow2, vmdk, vhdx, qed, raw, network | raw only |
| BIOS/UEFI | SeaBIOS, OVMF, multi-machine | None (PVH direct boot) |
| Devices | ~300 models, legacy IDE/VGA/serial-mouse included | virtio-blk/-net/-vsock + serial |
| Machine types | ~150 | One (microvm-shaped) |
| Migration | Live with VMState compat across years | Snapshot/restore only |
| Architectures | ~30 guest, ~10 host | x86_64 + aarch64 |
| Accelerators | TCG, KVM, Xen, HVF, WHPX, NVMM | KVM only |
| LoC | ~1.5 M (C) | ~50 K (Rust) |

Same `/dev/kvm`. The 30× LoC ratio is what feature universality costs.

### Mapping back to the traditional VMM framework

Cross-referencing the survey chapters to QEMU's frameworks:

| Survey chapter | QEMU realization |
|---|---|
| §02 placement / interface | Type-2 hosted (with KVM) or in-process emulator (TCG); guest interface set by which devices the machine type instantiates |
| §03 anatomy components | See §2 of this note |
| §04 CPU virtualization | Accelerator vtable. KVM → VMX. TCG → translator + soft-MMU. Same `CPUState` either way |
| §05 memory virtualization | MemoryRegion + AddressSpace tree, flattened to memslots (KVM) or TLB (TCG). Memory backends (anon/hugetlb/file) chosen by `-object memory-backend-*` |
| §06 I/O virtualization | qdev devices in `hw/`; virtio + vhost for fast path; block layer for storage. Userspace is where every device lives |
| §07 cross-domain communication | QMP for control; for guest↔host data the answer is `MemoryRegion` MMIO callbacks (slow path) + ioeventfd/irqfd (fast path) — see [KVM](/virtualization/systems/kvm/) §07 |
| §08 VM management | QMP `device_add` / `migrate` / `snapshot-save`; `vl.c::main()` orchestrates startup; migration framework owns lifecycle moves |

### Relationship to Astervisor

QEMU is *not* a precedent for Astervisor — opposite premises (universal compatibility vs. cooperating Rust guests; hardware isolation vs. language isolation; 1.5 MLoC vs. small TCB). It's a cautionary case study about scope.

**Cautionary:**
- **Compatibility expansion is unbounded.** ~300 device models because someone needed each. Astervisor's commitment to cooperating Rust guests is what prevents this — only if maintained against pressure.
- **"Everything composes with everything" produces 1.5 MLoC.** QOM, qdev, accelerators, AddressSpace, BlockBackend filters, VMState — every framework justified by a wide combinatorial space. Astervisor's space is *much* smaller by design; resist building general-purpose frameworks where a small fixed set will do.
- **The BQL is a warning about late fine-grained locking.** Astervisor's concurrency model should be designed without a BQL-equivalent from day one.
- **Migration is the tax compatibility imposes.** Every device has migration code. If migration is ever in scope for Astervisor, design it in from day one.

**Positive:**
- **A plug-in accelerator is structurally good.** Same QEMU binary pivoting between TCG and KVM at runtime — rest of code accelerator-agnostic — is the design that survived 20 years of changing hardware support. Astervisor's vCPU model should have a clean "what makes guest code execute" abstraction.
- **Frameworks beat ad-hoc code, even at small scale.** qdev's "properties + realize + vmsd" template means new devices look like old ones. Astervisor's domain model should have a single device-backend pattern.
- **A schema'd control plane compounds.** QMP generated from a JSON schema gave libvirt/OpenStack/KubeVirt/Proxmox machine-readable bindings. A small Serde-typed Rust control surface for Astervisor would do the same.
- **Runtime object introspection is load-bearing.** QOM lets the monitor walk the whole machine without per-device monitor code. Worth designing for early.

## What QEMU teaches that hypervisor notes don't

- **What a mature userspace VMM looks like**: 1.5 MLoC C, 300 devices, decades of migration discipline, six accelerator backends, hundreds of machine types, a JSON-RPC control plane.
- **What a portable binary translator looks like**: TCG — ~150 IR ops, per-target front-end, per-host back-end, helpers as escape hatch, soft-MMU as the bridge to guest paging.
- **What "same binary, five customer profiles" looks like**: cloud VMM, embedded developer, kernel CI, cross-compile tooling, Wine-style binary loader — all the same code.
- **Where complexity actually lives in a VMM**: not in CPU/MMU paths (small, especially when KVM does them) but in *devices*, *image formats*, *migration*. Count device-model lines, not vCPU lines, when sizing a VMM project.

## Source map

```text
qom/                              — QOM core
  object.c                        — TypeInfo, ObjectClass, Object, properties, type_initialize
hw/                               — qdev devices, by category
  core/                           — DeviceState, BusState, qdev framework
  pci/, virtio/, net/, block/, usb/, display/, intc/, timer/, acpi/, i386/, arm/, riscv/, …
target/                           — CPU front-ends
  i386/, arm/, riscv/, ppc/, mips/, sparc/, s390x/, …
  <arch>/translate.c              — guest-insn → TCG IR
  <arch>/helper.c                 — escape-hatch C functions
tcg/                              — TCG IR + back-end
  tcg.c, tcg-op.c                 — IR construction
  optimize.c                      — IR optimizer
  <host>/tcg-target.c.inc         — host code generator
accel/
  accel-common.c, accel-system.c  — AccelClass / AccelOpsClass base
  tcg/cpu-exec.c                  — cpu_exec() loop
  tcg/cputlb.c, tcg-runtime.c     — soft-MMU
  kvm/kvm-all.c                   — KVM acceleration
  xen/, hvf/, whpx/, nvmm/        — other accelerators
softmmu/                          — system-mode core
  vl.c                            — main(); CLI parsing; startup orchestration
  memory.c                        — MemoryRegion / AddressSpace
  cpus.c                          — per-vCPU thread management
  main-loop.c                     — main event loop
linux-user/                       — user-mode Linux (main.c, syscall.c, elfload.c)
block/                            — block layer (block.c, qcow2.c, raw-format.c, nbd.c, mirror.c, …)
migration/                        — live migration (migration.c, ram.c, savevm.c, multifd.c, postcopy-ram.c)
qapi/                             — JSON schema for QMP
monitor/                          — HMP + QMP dispatch
pc-bios/                          — firmware blobs (SeaBIOS, OVMF, OpenBIOS, …)
util/                             — utilities (event loops, AIO, threading)
```
