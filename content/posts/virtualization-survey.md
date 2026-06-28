---
date: '2026-05-17T21:00:00+08:00'
draft: false
title: 'Virtualization Series'
slug: 'virtualization-survey'
tags: ["Virtualization", "Hypervisor", "Systems"]
series: ["Virtualization Series"]
summary: "A guided tour of traditional machine virtualization, organized as ten chapters from foundations through performance, plus per-system case studies grounded in source-code reading."
author: "Anekoique"
ShowToc: false
ShowBreadCrumbs: true
cover:
  hidden: true
---

A survey of traditional machine virtualization, structured as ten chapters plus per-system case studies. Each chapter is a self-contained note; the case studies map a concrete system onto the [taxonomy](/virtualization/taxonomy/) and walk its components per the [architecture](/virtualization/vmm-architecture/) chapter.

Start with [History](/virtualization/history/) for the long view, or jump to [Foundations](/virtualization/foundations/) to begin the technical sequence.

## Traditional Virtualization

0. **[History](/virtualization/history/)** — Sixty years of virtualization in five eras.
1. **[Foundations](/virtualization/foundations/)** — What a VMM is and the Popek–Goldberg condition.
2. **[Taxonomy](/virtualization/taxonomy/)** — The four axes of VMM design.
3. **[Hypervisor Architecture](/virtualization/vmm-architecture/)** — The component set and three shapes.
4. Core Virtualization Mechanisms
    - **[CPU](/virtualization/cpu/)** — How guest code runs, and vCPU scheduling.
    - **[Memory](/virtualization/memory/)** — Shadow page tables, nested paging, and overcommit.
    - **[I/O](/virtualization/io/)** — Emulation vs paravirtual vs direct assignment.
5. **[Cross-Domain Communication](/virtualization/communication/)** — Hypercalls, rings, grant tables, capabilities.
6. **[VM Management and Cloud Extensions](/virtualization/vm-management/)** — Lifecycle, migration, microVMs, orchestration.
7. **[Performance and Overhead](/virtualization/performance/)** — Where the costs come from, and what remains.

## Systems and Case Studies

Per-system notes grounded in source-code reading, structured along the chapter outline above. Each note maps the system onto the [§02](/virtualization/taxonomy/) taxonomy tuple, walks its components per [§03](/virtualization/vmm-architecture/), and contrasts its choices with the rest of the field.

**Type-1 hypervisors:**

- **[Xen](/virtualization/systems/xen/)** — the canonical disaggregated paravirt Type-1.
- **[hvisor](/virtualization/systems/hvisor/)** — Rust separation-kernel hypervisor with static partitioning.
- **[AxVisor](/virtualization/systems/axvisor/)** — Rust hypervisor built as an ArceOS unikernel application.
- **[VMware ESXi](/virtualization/systems/vmware/)** — the canonical commercial monolithic Type-1.

**Type-2 / hosted:**

- **[KVM](/virtualization/systems/kvm/)** — the canonical hosted hypervisor; a Linux kernel module.
- **[QEMU](/virtualization/systems/qemu/)** — the universal machine emulator and userspace VMM.
- **[VirtualBox](/virtualization/systems/virtualbox/)** — Oracle's cross-platform desktop Type-2.

**MicroVMs and container-VM hybrids:**

- **[Firecracker](/virtualization/systems/firecracker/)** — AWS's minimal Rust microVM behind Lambda and Fargate.
- **[Kata Containers](/virtualization/systems/kata/)** — containers wrapped in microVMs for hardware isolation.

**Language-isolated systems:**

- *RedLeaf* — planned (Rust OS with language-checked domains).

**Container runtimes** (not hypervisors, but adjacent on the isolation-boundary axis):

- **[Docker](/virtualization/systems/docker/)** — the canonical OS-level virtualization stack.
- **[gVisor](/virtualization/systems/gvisor/)** — Google's userspace-kernel sandbox.
