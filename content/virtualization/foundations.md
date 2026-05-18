---
date: '2026-05-17T18:00:00+08:00'
draft: false
title: 'Virtualization Series 01 — Foundations'
slug: 'foundations'
tags: ["Virtualization", "Hypervisor", "Systems"]
series: ["Virtualization Series"]
summary: "What virtualization is, why it is used, and the Popek–Goldberg condition for virtualizability. Sets up the trap-and-emulate discipline that the rest of the survey treats as ambient context."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

## Definition

Virtualization is the technique of presenting virtual instances of physical resources. In traditional machine virtualization, the central abstraction is the **virtual machine**: a software-defined machine that provides virtual CPUs, memory, devices, interrupts, timers, and boot interfaces to a guest operating system.

The guest operating system runs as if it owns a complete physical machine. In reality, the machine is created, controlled, and isolated by a lower-level software layer called the **virtual machine monitor** (VMM), or **hypervisor**.

```
physical hardware
    ↓
VMM / hypervisor
    ↓
virtual machine
    ↓
guest operating system
    ↓
guest applications
```

The essential idea is therefore: **virtualization gives each guest the illusion of owning a machine, while the VMM retains control over the real machine.**

## Virtual Machine Monitor

A **virtual machine monitor** is the control layer that constructs and manages virtual machines. It has two complementary roles.

First, it provides a **virtual hardware interface** to the guest, including virtual CPUs, virtual memory, virtual devices, virtual interrupts, and virtual timers.

Second, it mediates access to the **real hardware**, including physical CPUs, host physical memory, real devices, interrupt controllers, DMA-capable devices, and global machine state.

This creates the central tension of traditional virtualization: the guest must believe it controls the machine, while the VMM actually does. The guest may control its virtual machine, but it must not directly control the real one.

## Motivation

Virtualization is useful because it turns physical hardware into a manageable and shareable abstraction. It supports server consolidation, fault and security isolation between tenants, compatibility with software requiring dedicated hardware, lifecycle operations such as snapshot and migration, and fine-grained resource accounting. These uses explain why virtualization became important not only as a systems technique, but also as a foundation for data centers and cloud computing.

This survey is concerned primarily with the **isolation** and **resource-control** motivations.

## Classical VMM Requirements

[Popek and Goldberg (CACM 1974)](https://dl.acm.org/doi/10.1145/361011.361073) define three classical requirements for a virtual machine monitor.

- **Equivalence** means that software running inside the virtual machine should behave essentially as it would on real hardware.

- **Resource control** means that the VMM must remain in ultimate control of real hardware resources. A guest may manipulate virtual resources, but it must not directly control host physical memory, real devices, or global privileged machine state.

- **Efficiency** means that most guest instructions should execute directly on the hardware without VMM intervention. The VMM should intervene only when the guest performs operations that affect virtualization correctness or resource control.

In short: **illusion, control, and native speed.**

## Virtualizability

The classical virtualization model depends on the distinction between **sensitive instructions** and **privileged instructions**.

A **sensitive instruction** is an instruction that can affect or observe machine state relevant to virtualization. Examples include operations that modify memory translation, change privilege state, access I/O, configure interrupts, or observe privileged machine state.

A **privileged instruction** is an instruction that traps when executed without sufficient privilege.

The classical condition for efficient virtualization is `sensitive ⊆ privileged` — every instruction that could break the virtual machine abstraction must trap when executed by the guest.

If this condition holds, the VMM can use the classic **trap-and-emulate** model:

```
ordinary guest instruction
    → runs directly on hardware

sensitive guest operation
    → traps to VMM
    → VMM validates or emulates the operation
    → guest resumes
```

This model is elegant because ordinary execution remains fast, while the VMM automatically regains control when the guest attempts an operation that must be mediated.

However, not all architectures naturally satisfy this condition. 32-bit x86 prior to VT-x and AMD-V, for example, had sensitive instructions that did not reliably trap outside the most privileged mode. This gap motivated later techniques such as [binary translation](/virtualization/cpu/), [paravirtualization](/virtualization/cpu/), and [hardware-assisted virtualization](/virtualization/cpu/), which belong to the later sections on taxonomy and core mechanisms.

## What this survey does next

The remainder of this survey examines how real systems satisfy these requirements in practice. The [next section](/virtualization/taxonomy/) establishes a taxonomy of VMM designs along the axes of placement, guest interface, hardware support, and isolation boundary; subsequent sections then treat the core mechanisms — [CPU](/virtualization/cpu/), [memory](/virtualization/memory/), [I/O](/virtualization/io/), and [cross-domain communication](/virtualization/communication/) — through which the classical requirements are concretely realized or worked around.
