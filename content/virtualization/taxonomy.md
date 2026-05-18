---
date: '2026-05-17T17:00:00+08:00'
draft: false
title: 'Virtualization Series 02 — Taxonomy'
slug: 'taxonomy'
tags: ["Virtualization", "Hypervisor", "Systems"]
series: ["Virtualization Series"]
summary: "The four largely-independent axes of VMM design: placement (Type 1 vs Type 2), guest interface (full vs paravirtual), hardware support (VT-x, EPT, IOMMU), and isolation boundary (hardware, software, language)."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The [previous section](/virtualization/foundations/) established what a VMM is and the classical condition under which one can be built efficiently. Real virtualization systems differ along several axes that are mostly **independent of one another**: a system's choice on one axis does not determine its choice on another. KVM is a hosted VMM with an unmodified guest interface; Xen began as a bare-metal VMM with a paravirtualized guest interface and now also supports unmodified guests. Conflating these axes — as the common textbook taxonomy of "Type 1 vs. Type 2" and "Full vs. Para vs. Hardware-Assisted" often does — obscures the actual design space.

This section separates the axes explicitly. Four matter:

1. **Placement** — where the VMM sits in the software stack.
2. **Guest interface** — what the guest sees, and whether it has been modified to know it is virtualized.
3. **Hardware support** — what the CPU and platform provide to make virtualization efficient.
4. **Isolation boundary** — what mechanism enforces separation between guest and VMM.

The first three are familiar from the classical literature. The fourth is included because it is the one axis on which essentially every traditional system makes the same choice, and the design space along it is largely unexplored.

The purpose of this section is to *name* and *distinguish* the axes. The mechanisms by which each axis is implemented in practice — binary translation, EPT, virtio rings, and so on — are deferred to the [core mechanisms sections](/virtualization/cpu/).

## Placement

The placement axis describes where the VMM executes relative to the rest of the software stack — in particular, whether it runs directly on the hardware or on top of an existing operating system.

### Type 1: bare-metal VMM

A **Type 1** (or **bare-metal**) VMM runs directly on the physical hardware. It is the most-privileged software on the machine; there is no host OS beneath it.

```text
guest OS    guest OS    guest OS
   │           │           │
   └───────────┼───────────┘
               │
        VMM (bare-metal)
               │
          hardware
```

Examples include Xen, VMware ESXi, and Microsoft Hyper-V. Bare-metal VMMs typically achieve lower overhead than hosted ones and minimize the trusted computing base (TCB) by excluding a general-purpose OS from the privileged path. The trade-off is that the VMM must implement, or delegate, all device drivers and platform management itself.

In practice, most Type 1 VMMs delegate device handling to a privileged guest, often called a *driver domain* (Xen's `dom0`) or *parent partition* (Hyper-V), which runs a full OS and provides backend drivers to other guests. The VMM proper is small, but the system as a whole still depends on a full OS for I/O.

### Type 2: hosted VMM

A **Type 2** (or **hosted**) VMM runs as a process or kernel module on top of a conventional host operating system. The host OS owns the hardware; the VMM borrows CPU and memory from it on the host's terms.

```text
guest OS    guest OS
   │           │
   └───────────┘
        │
       VMM ──┐
             │
          host OS
             │
          hardware
```

Examples include VMware Workstation, VirtualBox, and KVM (where the Linux kernel is the host OS and KVM is a kernel module). Hosted VMMs reuse the host's device drivers, scheduler, and memory manager, which dramatically reduces implementation cost. The trade-offs are a larger TCB (the entire host kernel is trusted) and a longer path to hardware.

### The blurred boundary

The Type 1 / Type 2 distinction is less crisp in modern systems than the classical taxonomy suggests. KVM is conventionally classified as Type 2 because it depends on Linux, but it uses hardware virtualization extensions to run guests at the same privilege level a Type 1 VMM would. Xen is conventionally classified as Type 1, but its dependence on `dom0` means a full Linux kernel is trusted in practice. The placement axis remains useful for describing the *architectural* relationship between VMM and OS, but it is a weaker predictor of performance and TCB size than it once was.

## Guest Interface

The guest-interface axis describes what the guest sees: whether the virtual machine the VMM presents is *identical* to a real machine (so an unmodified OS runs on it) or whether the interface has been *modified* in ways the guest must be aware of.

### Full virtualization

In **full virtualization**, the guest sees an interface indistinguishable from real hardware. The guest OS runs unmodified; it does not know it is virtualized. The advantage is compatibility — any OS that runs on the bare hardware runs in the VM. The cost is that the VMM must faithfully emulate every architectural detail the guest might observe, including legacy device interfaces, BIOS/firmware, and corner cases of CPU semantics.

### Paravirtualization

In **paravirtualization**, the VMM exposes a *modified* interface in which the most expensive or non-virtualizable parts of the architecture are replaced by explicit calls into the VMM (**hypercalls**). The guest OS is ported to this interface — it knows it is virtualized and cooperates with the VMM.

Paravirtualization was historically motivated by the x86 virtualization gap, but it is also used purely for **performance**: a paravirtual I/O interface (such as `virtio`) avoids the cost of emulating a real device by having the guest cooperate directly with the VMM through a shared ring buffer. The trade-off is that the guest OS must be modified, which precludes running closed-source operating systems unmodified and creates a maintenance burden as guest kernels evolve.

### Hybrid interfaces in practice

Most modern systems are hybrids. A typical configuration runs an unmodified guest OS (full virtualization, made efficient by hardware assistance) but uses paravirtual drivers (`virtio-net`, `virtio-blk`) for performance-critical I/O. The guest is "fully virtualized" with respect to CPU and memory and "paravirtualized" with respect to I/O. The clean Full / Para dichotomy of the early literature has largely given way to this mixed model.

## Hardware Support

The hardware-support axis describes what the underlying platform provides to make virtualization efficient — specifically, whether the CPU and platform offer features that close the Popek–Goldberg gap and reduce the cost of common virtualization operations.

This section names the categories of hardware support a VMM may rely on; the mechanisms themselves are treated in the core-mechanisms sections.

- **No hardware support.** The VMM closes the virtualizability gap entirely in software, by rewriting the guest's instruction stream or by modifying the guest. This is the regime in which the early VMware products and the original Xen operated.
- **CPU virtualization extensions** (Intel VT-x, AMD-V). The CPU adds a new operating mode in which the VMM executes; sensitive operations by the guest cause a trap into the VMM, restoring the classical trap-and-emulate model on architectures that originally lacked it.
- **Memory virtualization extensions** (Intel EPT, AMD NPT). The MMU adds a hardware-walked second translation layer, eliminating the need for the VMM to maintain shadow page tables.
- **I/O virtualization extensions** (Intel VT-d / IOMMU, SR-IOV). The platform virtualizes DMA and lets physical devices safely present multiple virtual functions to the host, enabling near-native I/O without VMM mediation on every transaction.

These categories are mostly cumulative in practice: a modern x86 VMM uses CPU, memory, and I/O extensions together. They are listed separately because they were introduced in stages, and a system may rely on some without the others (early hardware-assisted VMMs used VT-x but still maintained shadow page tables, for example).

It is worth being precise about what hardware support does and does not provide. Hardware extensions make virtualization *efficient* — they reduce the cost of preserving the classical requirements. They do not, by themselves, make a system *secure*: a bug in the VMM remains a bug, and the trusted computing base of a hardware-assisted VMM is comparable to or larger than that of a software-only one. The axis here is performance and engineering complexity, not isolation strength.

## Isolation Boundary

The previous three axes describe choices that every traditional VMM faces. The **isolation boundary** axis describes the *mechanism* by which the VMM is protected from its guests — and it is the axis on which the design space is, in current practice, almost entirely unexplored.

In every traditional system surveyed in this chapter, the isolation boundary is a **hardware privilege boundary**: the VMM executes at a higher CPU privilege level than the guest, controls separate page tables that the guest cannot modify, and confines DMA-capable devices through hardware enforcement. These mechanisms differ in detail but share a common structure: **isolation is achieved by hardware features that distinguish "VMM memory" from "guest memory" and "VMM instructions" from "guest instructions" at silicon level.** The Popek–Goldberg condition is, in the end, a statement about hardware: it asks whether the hardware traps the right instructions at the right privilege level.

Two non-traditional alternatives appear in the literature:

- **Software fault isolation (SFI).** The guest's code is rewritten or verified before execution to guarantee it cannot access memory or invoke operations outside its allocation. The boundary is a property of the *code itself*, enforced by a verifier rather than by hardware. SFI has been used in browser sandboxes (NaCl) and OS extension mechanisms (BPF, eBPF) but not, historically, for full system virtualization.
- **Language-level isolation.** The guest is written in a safe language, and the language's type system and runtime statically guarantee that a guest cannot forge a pointer, escape its allocated regions, or invoke privileged operations it has not been granted. The boundary is a property of the *type system* and is enforced at compile time. This is the approach taken by Singularity (Sing#), RedLeaf (Rust), and Theseus (Rust).

A third alternative — neither pure software nor a pure language guarantee — has emerged in industry under the heading of **confidential computing**: AMD SEV (and SEV-SNP), Intel TDX, and ARM CCA. These mechanisms rest on hardware extensions but invert the traditional trust model: the VMM is treated as *untrusted*, and the hardware encrypts guest memory and CPU state so that even a compromised hypervisor cannot read or modify what runs inside the protected guest. Attestation replaces software-layer trust. This addresses tenant-vs.-VMM isolation (the dominant security concern in multi-tenant cloud), but it preserves and even widens the existing TCB-size and per-VM performance overheads. Confidential computing is therefore complementary to, not in competition with, language-level isolation: the two address different parts of the threat model.

The rest of this survey treats the hardware boundary as the default — every traditional system uses it, and every cost analysis assumes it.

## Mapping the Design Space

Because the four axes are independent, every concrete system can be described as a tuple of four choices. A few representative points in the space:

| System | Placement | Guest Interface | Hardware Support | Isolation Boundary |
|---|---|---|---|---|
| VMware Workstation (early, pre-2007) | Type 2 | Full (binary translation) | None | Hardware (rings) |
| Xen (original, 2003) | Type 1 | Paravirtual | None | Hardware (rings) |
| KVM (modern) | Type 2 (hosted in Linux) | Full | CPU + memory + I/O | Hardware (root/non-root) |
| Xen (modern) | Type 1 | Full or Paravirtual | CPU + memory + I/O | Hardware (root/non-root) |
| Firecracker | Type 2 (hosted in Linux/KVM) | Full (minimal device set) | CPU + memory + I/O | Hardware (root/non-root) |
| RedLeaf | Type 1-like | Custom (Rust domains) | Minimal | **Language-level (Rust)** |

The table is not exhaustive but illustrates the point: the axes can be combined freely, and the most underexplored quadrant of the space is the fourth column — every traditional system makes the same choice there.

## What this section established

The traditional virtualization design space has four largely-independent axes. The first three — placement, guest interface, hardware support — are the dimensions along which traditional systems differ from one another. The fourth — isolation boundary — is the one along which traditional systems are uniform, and the one most current research is trying to open up.

The next section, [VMM Architecture](/virtualization/vmm-architecture/), takes the placement axis as its starting point and examines the *internal* structure of a VMM — the components every VMM contains and the architectural shapes (monolithic, hosted, disaggregated) into which they are organized. The core-mechanisms sections that follow then revisit the guest-interface and hardware-support axes in detail: [CPU](/virtualization/cpu/) examines how full and paravirtual interfaces are realized and how CPU hardware extensions support them; [Memory](/virtualization/memory/) and [I/O](/virtualization/io/) do the same for their respective resources.
