---
date: '2026-05-17T16:00:00+08:00'
draft: false
title: 'Virtualization Series 03 — Hypervisor Architecture'
slug: 'vmm-architecture'
tags: ["Virtualization", "Hypervisor", "Systems"]
series: ["Virtualization Series"]
summary: "The recurring component set inside a VMM (vCPU, memory, device, interrupt/timer, exit handler, control plane) and the three architectural shapes (monolithic, hosted, disaggregated) they organize into."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The [previous section](/virtualization/taxonomy/) classified VMMs along four external axes — placement, guest interface, hardware support, and isolation boundary. This section turns inward: once a VMM occupies a point in that design space, what is it *made of*? What are the components inside it, and how do they fit together?

The internal structure of a VMM is determined less by its placement than by a single recurring question: **for each guest-visible resource — vCPUs, memory, devices, interrupts, time — which component models the resource, which controls the real hardware behind it, and how do the two communicate?** Every traditional VMM answers this question with the same small set of components, organized in one of a handful of recurring shapes. This section names those components and shapes.

The mechanisms by which each component does its job — how a vCPU is actually scheduled onto a pCPU, how a guest page table is translated, how a virtio ring is processed — are deferred to the [core mechanisms sections](/virtualization/cpu/). Here we are interested in the *architecture*: the boxes and arrows, not the algorithms inside the boxes.

## The Anatomy of a VMM

Most traditional VMMs can be understood as containing, in some form, the following components. The names differ between systems; the responsibilities recur.

### The control plane

The **control plane** is the part of the VMM that creates, configures, destroys, and observes virtual machines. It is invoked by external operators (humans, orchestrators, cloud control systems) and translates their requests into the internal operations that bring a VM into existence: allocating memory, instantiating vCPUs, attaching devices, loading a boot image, and eventually starting execution.

The control plane is usually not on the guest's steady-state execution path. A running guest normally interacts with the data path rather than the lifecycle/configuration path, although operations such as hotplug, migration, or snapshotting may temporarily involve control-plane logic.

### The vCPU model

The **vCPU model** is the component that represents a guest's virtual processors and arranges for them to execute. For each vCPU, the VMM holds a data structure containing the vCPU's architectural state (registers, control registers, segment state, interrupt state) and a scheduling decision about *which* physical CPU it should run on, and *when*.

When a vCPU runs, the VMM installs its architectural state into the hardware virtualization context and transfers control to guest execution. When the vCPU stops running — because it voluntarily yields, because the scheduler preempts it, or because it executes a sensitive operation that returns control to the VMM — the VMM saves its state and decides what to do next. This save/restore cycle, and the policy that drives it, is what the vCPU model is.

### The memory model

The **memory model** is the component that maintains the relationship between **guest-physical** addresses (the addresses a guest believes it is using) and **host-physical** addresses (the addresses the real hardware recognizes). It allocates host memory to back guest memory, installs the translations that make that backing visible to the guest, and either intercepts guest operations that change those translations, or — when hardware permits — lets the guest manage its own translations while the VMM retains control of the underlying host-physical mapping.

The memory model also implements whatever **overcommit** policy the VMM offers — the mechanisms by which a VMM presents more guest memory than it has host memory to back, and reclaims host memory from guests under pressure.

### The device model

The **device model** is the component that presents virtual devices to the guest. For each virtual device, the device model defines what the guest sees (a set of registers, a memory-mapped region, an interrupt) and what happens when the guest interacts with it (the requested I/O is performed against some real resource on the host side).

Device models are heterogeneous in a way the other components are not. A VMM typically contains many of them — one per emulated device type, plus paravirtual back-ends for `virtio`-class devices, plus pass-through paths for devices assigned directly to a guest. Some device models are tiny (a serial port); others are substantial systems in their own right (a virtual block device with image-format support, snapshotting, and copy-on-write).

### The interrupt and timer model

The **interrupt model** delivers virtual interrupts to vCPUs: it implements the guest-visible interrupt controller (the virtual local APIC, the virtual I/O APIC, or their architectural equivalents), accepts interrupt requests from device models, and arranges for the appropriate vCPU to observe them at the right time. The **timer model** does the analogous job for time: it presents virtual timer devices to the guest, multiplexes them onto real hardware timers, and is responsible for the guest's view of wall-clock and monotonic time.

Interrupts and time are grouped together because in practice they are tightly coupled: virtual time advances on the basis of interrupts, and many of the most expensive paths in a VMM (frequent timer ticks, high-rate device interrupts) involve both components. **Time virtualization** is itself a non-trivial sub-problem: a guest expects a monotonically advancing TSC and consistent wall-clock readings, but real time skips forward across migration, vCPU descheduling, and host suspend. Production VMMs use paravirtual time interfaces (`kvmclock` on KVM, equivalent mechanisms on Xen and Hyper-V) so that the guest can ask the VMM rather than rely on the real TSC; this is a recurring source of subtle overhead noted in [§09](/virtualization/performance/).

### The exit handler

The **exit handler** is the component that runs when a vCPU stops executing because of a virtualization event — a privileged instruction trap, a page fault that the memory model must resolve, an MMIO access that must be routed to a device model, an interrupt that must be injected. It dispatches the event to whichever component owns it, waits for that component to act, and resumes the vCPU.

The exit handler is small in code but central in design. Its dispatch table is, in effect, the contract between the vCPU model and every other component: it lists every reason a vCPU might exit and names who handles it.

### Summary

```
                  ┌─────────────────┐
                  │  control plane  │  (lifecycle, config, observability)
                  └─────────────────┘
                          │
                          ▼
   ┌───────────────────────────────────────────────────┐
   │                   exit handler                    │
   └───────────────────────────────────────────────────┘
       ▲           ▲           ▲              ▲
       │           │           │              │
   ┌───────┐  ┌────────┐  ┌──────────┐  ┌──────────────┐
   │ vCPU  │  │ memory │  │  device  │  │ interrupt /  │
   │ model │  │ model  │  │  models  │  │ timer model  │
   └───────┘  └────────┘  └──────────┘  └──────────────┘
```

Every component talks to the exit handler; few components talk to each other directly. In hardware-assisted VMMs, the exit handler is the spine of the VMM.

## Architectural Shapes

Given the same set of components, VMMs differ in *where* the components are placed and *what trust relationships* hold between them. Three shapes recur.

### Monolithic

In a **monolithic** VMM, all components — control plane, vCPU model, memory model, device models, interrupt and timer models, exit handler — live in a single address space at the highest privilege level available to software. There are no internal isolation boundaries; a bug in one device model can corrupt any other component.

```
┌──────────────────────────────────────────────┐
│  control plane │ vCPU │ memory │ devices │…  │   ← single address space,
└──────────────────────────────────────────────┘     highest privilege
                       │
                  hardware
```

VMware ESXi (in its original form) and most embedded hypervisors take this shape. The advantage is performance: any component can call any other directly, with no boundary crossings. The disadvantage is TCB size — every line of code in the VMM, including every device model, is fully trusted.

### Hosted

In a **hosted** VMM, the components are split between a privileged kernel-mode core (vCPU model, memory model, exit handler) and one or more user-mode helpers (device models, control plane). The kernel core is small and contains only the fast paths that must run privileged; the user helpers are processes on the host OS, isolated by the host's normal process boundaries. (Earlier hosted VMMs — VMware Workstation, VirtualBox — placed more of the VMM in user space and used a kernel driver only for the bare minimum of privileged operations; the modern KVM-style split described here is the dominant shape today.)

```
              ┌─────────────────────┐
              │  user-mode helper:  │   ← host process,
              │  device models,     │     unprivileged
              │  control plane      │
              └─────────────────────┘
                        │  (syscalls / ioctl)
              ┌─────────────────────┐
              │  kernel core:       │   ← host kernel module,
              │  vCPU, memory,      │     privileged
              │  exit handler       │
              └─────────────────────┘
                        │
                    hardware
```

KVM with QEMU is the canonical example of the kernel/user split: the KVM kernel module provides the privileged execution core, while QEMU (or `crosvm`, or Firecracker's VMM process) supplies device models and much of the control plane. The split has two consequences. First, a bug in a device model can corrupt only the user helper, not the kernel core or other guests on the host — a smaller blast radius than in a monolithic VMM. Second, the path from a guest I/O request to its handling is longer: the exit handler must round-trip from kernel to user and back.

### Disaggregated

In a **disaggregated** VMM, the device models themselves are separated from one another, each running in its own isolated context. The kernel core remains small, the control plane is one process, and each device model — or each *driver* — is a distinct domain whose failure or compromise cannot directly affect the others.

```
          ┌──────────┐  ┌──────────┐  ┌──────────┐
          │ net      │  │ block    │  │ console  │
          │ driver   │  │ driver   │  │ driver   │      ← isolated,
          │ domain   │  │ domain   │  │ domain   │        per-driver
          └──────────┘  └──────────┘  └──────────┘
                ▲             ▲             ▲
                │             │             │
          ┌──────────────────────────────────────┐
          │           kernel core                │      ← small,
          │     (vCPU, memory, exit handler)     │        privileged
          └──────────────────────────────────────┘
                              │
                          hardware
```

Xen is the production example closest to this shape: device drivers are outside the hypervisor, usually in `dom0` and sometimes in dedicated *driver domains*. Microkernel-style hypervisors (NOVA, seL4-based VMMs) take the same approach more aggressively, isolating not only drivers but also memory management and even parts of the scheduler.

The advantage is that the TCB of the privileged kernel core shrinks dramatically — often by an order of magnitude — and a bug in any driver is contained to a single domain. The cost is that every cross-component interaction is now a cross-domain interaction, and the mechanism that carries it (a hypercall, a shared ring, a synchronous IPC) becomes the dominant performance concern. [§07 Cross-Domain Communication](/virtualization/communication/) surveys the full set of mechanisms — hypercalls, shared-memory rings, grant tables, and capabilities — and the cost anatomy that determines whether disaggregation is worthwhile. A disaggregated architecture is, in effect, a bet that the communication mechanism is fast enough that the isolation gain is worth its cost.

### A note on the spectrum

Real systems do not always fall cleanly into one shape. KVM is hosted, but the user-mode helper (QEMU) is itself monolithic with respect to its devices — a bug in QEMU's network model can corrupt its block model. Xen is disaggregated for drivers, but `dom0` itself contains many drivers in a single Linux kernel and is therefore internally monolithic. The shapes are points on a spectrum of how aggressively the *device model* and *driver* layers are subdivided; almost no system applies the same answer uniformly.

## How a Guest Operation Becomes Work

The components and shapes above are static descriptions. The dynamic behaviour of a VMM is best seen by following one operation from start to finish. Consider a guest issuing a network packet. (This is the standard exit-driven path; modern systems may shortcut some of these exits via `ioeventfd`-style notifications or polling, but the architectural shape is the same.)

1. The guest's network driver writes a buffer descriptor into a ring it shares with the VMM and rings a virtual doorbell — often a write to a memory-mapped location or notification register configured to notify the VMM, possibly through a VM-exit or an eventfd-style path.
2. The CPU exits to the VMM. The **exit handler** inspects the exit reason (an MMIO write to a known device region) and dispatches to the **device model** that owns that region.
3. The device model reads the descriptor, determines the buffer's location in guest-physical memory, and asks the **memory model** to translate or map that buffer into an address the backend can access — a host virtual address for a user-space device model, or a DMA address for an assigned device.
4. The device model performs the actual I/O — either by issuing a real send on a host network interface (in a hosted or monolithic VMM) or by forwarding the request to the appropriate **driver domain** (in a disaggregated one).
5. When the send completes, the device model asks the **interrupt model** to deliver a virtual interrupt to the guest's network device.
6. The interrupt model selects a target vCPU, marks the virtual interrupt pending, and — if that vCPU is currently running — causes it to exit so the interrupt can be injected on resume.
7. The vCPU resumes; the guest sees the interrupt; the guest's network driver completes the send.

Three things are worth noticing about this flow. First, **the exit handler appears twice**: once on the I/O submission, once on the interrupt delivery. Almost every interesting guest operation involves at least one round-trip through the exit handler, which is why VM-exit cost is the most-watched performance number in any VMM. Second, **multiple components participate in a single operation**, and a disaggregated architecture turns each component boundary into a cross-domain boundary. Third, **the path is asymmetric**: the submission path goes guest → VMM → host hardware; the completion path goes host hardware → VMM → guest. Optimizations applied to one direction often do nothing for the other.

## What Determines TCB Size

The architectural shape determines what is in the trusted computing base of the VMM, and TCB size is one of the few things this section can say cleanly across designs.

- **Monolithic.** TCB = the entire VMM, including every device model. Typically tens to hundreds of thousands of lines.
- **Hosted.** TCB = the kernel core *plus the entire host kernel*. The user-mode helper is usually outside the most privileged TCB, and a compromise should be confined by host process isolation; however, it remains trusted with respect to the VM it serves and with respect to any host resources exposed to that process. The host kernel underneath the VMM — Linux, in the KVM case — is in the TCB unconditionally, and host kernels are large; this is the dominant TCB cost in a hosted VMM.
- **Disaggregated.** TCB = the kernel core only, in the limit. Each driver domain is trusted only with respect to the resources it has been given access to; a compromised driver cannot directly corrupt other domains or the core.

The open question in this space: if a language-level boundary can substitute for a hardware privilege boundary, then "TCB" no longer means "all code at the highest privilege level" but "all code the type system cannot prove safe." Whether such a substitution actually closes the gap to the disaggregated TCB while preserving the performance of the monolithic one is the empirical question that motivates research like RedLeaf and Theseus.

## What this section established

A VMM is built from a small, recurring set of components — control plane, vCPU model, memory model, device models, interrupt/timer model, exit handler — that fit together along the spine of the exit handler. Three architectural shapes (monolithic, hosted, disaggregated) describe how those components are placed and what trust relationships hold between them; the choice of shape determines TCB size and the performance cost of common operations.

The next section, [CPU Virtualization](/virtualization/cpu/), opens the first of the component boxes and examines how the vCPU model is actually realized — how guest instructions execute, when they exit, and how the VMM regains control.
