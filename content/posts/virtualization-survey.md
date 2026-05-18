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

0. **[History](/virtualization/history/)** — Sixty years of virtualization in five eras, from IBM CP-40 to language-isolated microVMs.
1. **[Foundations](/virtualization/foundations/)** — What a VMM is and the Popek–Goldberg condition for trap-and-emulate.
2. **[Taxonomy](/virtualization/taxonomy/)** — Four axes of VMM design: placement, guest interface, hardware support, isolation boundary.
3. **[Hypervisor Architecture](/virtualization/vmm-architecture/)** — The recurring component set and three shapes: monolithic, hosted, disaggregated.
4. Core Virtualization Mechanisms
    - **[CPU](/virtualization/cpu/)** — Trap-and-emulate, binary translation, paravirtualization, hardware-assisted virtualization, and vCPU scheduling.
    - **[Memory](/virtualization/memory/)** — Shadow page tables, nested paging (EPT/NPT), and the overcommit toolbox.
    - **[I/O](/virtualization/io/)** — Full emulation vs paravirtual (virtio) vs direct assignment (SR-IOV).
5. **[Cross-Domain Communication](/virtualization/communication/)** — Hypercalls, rings, grant tables, capabilities — the substrate every non-monolithic VMM is built on.
6. **[VM Management and Cloud Extensions](/virtualization/vm-management/)** — Lifecycle, snapshotting, live migration, microVMs, fleet orchestration.
7. **[Performance and Overhead](/virtualization/performance/)** — Where the costs come from on modern hardware, and what residual tax remains.

## Systems and Case Studies

Per-system notes grounded in source-code reading, structured along the chapter outline above. Each note maps the system onto the [§02](/virtualization/taxonomy/) taxonomy tuple, walks its components per [§03](/virtualization/vmm-architecture/), and contrasts its choices with the rest of the field.

**Type-1 hypervisors:**

- **[Xen](/virtualization/systems/xen/)** — the canonical disaggregated paravirt Type-1; PV / HVM / PVH modes contrasted in depth.
- *hvisor*
- *axvisor*
- *VMware ESX*

**Type-2 / hosted:**

- *KVM*
- *QEMU*
- *VirtualBox*

**MicroVMs and container-VM hybrids:**

- *Firecracker*
- *Kata Containers*

**Language-isolated systems:**

- *RedLeaf*

**Container runtimes:**

- *Docker*
- *gVisor*
