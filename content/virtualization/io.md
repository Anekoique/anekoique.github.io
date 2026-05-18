---
date: '2026-05-17T13:00:00+08:00'
draft: false
title: 'Virtualization Series 06 — I/O Virtualization'
slug: 'io'
tags: ["Virtualization", "Hypervisor", "Systems", "I/O"]
series: ["Virtualization Series"]
summary: "Full device emulation vs paravirtual (virtio + vhost) vs direct assignment (SR-IOV). The order-of-magnitude performance spread, the role of IOMMU, APICv, and posted interrupts, and how all three coexist in production."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The device model, introduced in [§03](/virtualization/vmm-architecture/), presents virtual devices to the guest. This section examines the mechanisms behind it: how the guest interacts with a virtual device, how that interaction is translated into action against real hardware, and what trade-offs separate the three dominant approaches — full device emulation, paravirtual interfaces, and direct device assignment.

I/O is the part of virtualization where the gap between *what is possible* and *what is fast* is largest. CPU and memory virtualization on modern hardware run within a few percent of native; I/O virtualization spans an order of magnitude depending on which approach is chosen, and the approach matters more for workload performance than almost any other VMM design choice.

## The I/O Path

Three things must happen for any guest I/O operation to complete. The guest must indicate that it wants the operation performed (a *submission*); the operation must be performed against real hardware on the host side (the *backend work*); and the guest must learn that it has completed (the *completion*). Every I/O virtualization technique is fundamentally a different design for these three steps.

```
guest ──submit──→  VMM   ──backend──→  real hardware
                    ↑                       │
                    └────completion─────────┘
```

The cost of an I/O technique is dominated by what each step requires of the VMM:

- **Submission cost.** Does each request require a VM-exit, or can multiple requests be batched? Does the VMM have to decode an arbitrary instruction stream, or does it receive a structured request?
- **Backend cost.** Does the VMM perform the work itself, or does it delegate to the host kernel, to a separate driver domain, or to the device itself?
- **Completion cost.** Does each completion require an injected interrupt? Can the guest poll? Are interrupts coalesced?

The three approaches that follow make different choices at each step.

## Full Device Emulation

In **full device emulation**, the VMM presents the guest with a virtual device whose interface is bit-for-bit identical to a real hardware device — typically a popular older device with broad driver support, like an Intel e1000 NIC or an LSI SCSI controller. The guest's unmodified driver for that device interacts with it exactly as it would with the real hardware: programming registers via MMIO or PIO, setting up DMA descriptors, waiting for completion interrupts.

The VMM intercepts every register access, decodes the request, performs the requested I/O against some real backing resource (a host network interface, a host disk file), and injects an interrupt when complete.

```
guest driver (unmodified)
    │
    │ MMIO write / PIO out
    ▼
─── VM-exit ──────────────────────────
    │
    ▼
VMM device model
    │  decode, perform real I/O
    ▼
host I/O layer (kernel, file system)
    │
    ▼
real hardware
```

The advantages are uniform compatibility — any guest OS that supports the chosen device works without modification — and operational simplicity (the device interface is well understood and well documented). The costs are uniform: every register access traps; every completion injects an interrupt; the VMM must decode and emulate enough of the device's behavior to satisfy any quirk the guest driver might exercise.

In a hosted VMM (e.g., QEMU + KVM), each MMIO access by the guest costs at least one VM-exit and a kernel-to-user round-trip into the QEMU device model. For low-rate devices (a serial console, a CD-ROM) this is fine. For high-rate devices (a 10 GbE NIC, an NVMe SSD) it is catastrophic — the per-packet cost of full emulation is high enough that emulated network throughput is typically a small fraction of what the underlying hardware can deliver.

Full emulation persists not because it is fast but because it is universal: it is the fallback for any guest, any device, any workload that cannot use a paravirtual or pass-through path.

## Paravirtual I/O: virtio

**Paravirtual I/O** abandons the requirement that the virtual device look like real hardware. Instead, the VMM and the guest agree on a custom device interface designed for efficient virtualization: structured request submission, batched notifications, shared-memory data transfer. The guest is modified — it loads a paravirtual driver instead of a hardware-device driver — and in return gets I/O performance an order of magnitude better than full emulation.

The dominant paravirtual interface is **`virtio`**, originally developed for KVM and now supported across nearly every hypervisor (KVM, Xen, Hyper-V, VMware, Firecracker, ESXi). `virtio` is not a single device but a family of devices (`virtio-net`, `virtio-blk`, `virtio-scsi`, `virtio-gpu`, `virtio-fs`, etc.) that share a common transport mechanism.

### The virtqueue

The transport is the **virtqueue** — a producer/consumer ring shared between guest and VMM, holding **descriptors** that point to buffers in guest memory.

```
                    virtqueue (in shared memory)
       ┌────────────────────────────────────────────────┐
       │  desc 0 │ desc 1 │ desc 2 │ ... │ desc N       │
       └─────────┴────────┴────────┴─────┴──────────────┘
            ▲                                ▲
            │                                │
       guest writes                     VMM reads
       descriptors (req)                processes,
                                        writes used ring
                                                │
                                                ▼
                                          guest reads
                                          completions
```

A typical virtio operation:

1. The guest writes one or more descriptors into the *available* ring, each pointing to a buffer in guest memory holding (or destined to hold) the request data.
2. The guest writes a notification register (the **doorbell**) to tell the VMM new work is available.
3. The VMM reads the descriptors, performs the I/O, writes completion records into the *used* ring.
4. The VMM injects an interrupt to tell the guest there are completions.
5. The guest reads the used ring and processes completions.

The structure has several efficiency wins over full emulation:

- **Batching is natural.** Many descriptors can be submitted before the doorbell write; many completions can be processed before the guest re-enables interrupts. A single VM-exit can carry hundreds of operations.
- **Notification suppression.** The interface includes flags by which guest and VMM can suppress notifications during high-throughput phases. A backend that knows the guest is polling does not need to inject interrupts; a guest that knows the backend is polling does not need to ring the doorbell.
- **Shared-memory data transfer.** Buffers are referenced, not copied. The VMM accesses guest memory directly via the host virtual address it has for the guest's memory region.

### vhost: kernel-side acceleration

In a hosted VMM, the user-space device model is the obvious bottleneck on the virtio path. **vhost** moves the data path of selected virtio devices into the host kernel, eliminating the kernel-to-user round trip on every batch of operations.

```
   guest                     VMM (user)            host kernel
   ┌─────┐  ─doorbell→  ┌──────────────┐
   │     │              │ control plane│
   │     │              │ (setup only) │
   └─────┘              └──────────────┘
      │                                          ┌──────────────┐
      └──── direct I/O, kernel-side ─────────────│ vhost-net    │
                                                 │ vhost-scsi   │
                                                 │ vhost-blk    │
                                                 └──────────────┘
                                                        │
                                                        ▼
                                                  real hardware
```

The user-space device model still handles configuration and infrequent operations; high-rate I/O bypasses it entirely. The cost is a larger TCB — the vhost backend runs in the privileged host kernel — and a more complex configuration handshake. The benefit, especially for high-throughput network workloads, is substantial.

A further evolution, **vhost-user**, moves the data path into a separate user-space process (often a DPDK-based packet processor) that owns the host NIC directly. The guest still uses unmodified `virtio-net`; the VMM still presents the standard virtio device; the data path goes through whichever vhost target — kernel, user, or hardware — is configured. The virtio interface has, in effect, become a stable contract that decouples the guest driver from the backend implementation.

### virtio's role today

`virtio` is the universal I/O interface of cloud virtualization. It is used by Linux, Windows (via paravirtual driver packages), and most BSDs; it is the only I/O interface in microVMs like Firecracker, where the absence of legacy device emulation is a deliberate TCB-reduction choice. Its design has held up well: first described in [Russell's 2008 virtio paper](https://dl.acm.org/doi/10.1145/1400097.1400108) (developed at IBM/OzLabs to unify the multiple paravirtual driver stacks then in Linux), and standardized as OASIS VIRTIO v1.0 in 2014, with v1.1 (2019) and v1.2 (2022) extensions.

## Direct Device Assignment and SR-IOV

The third approach gives up emulation and paravirtualization both: the guest is given direct access to a real hardware device, and the VMM stays out of the data path entirely.

### Pass-through

In simple **pass-through** (sometimes called *VFIO* on Linux, or *PCI pass-through*), an entire physical device is assigned to a single guest. The guest's driver programs the real device's registers directly; the device DMAs into the guest's memory directly; completion interrupts are routed (with hardware help) to the guest's vCPU directly.

```
guest                                    real device
┌──────────────────┐                ┌──────────────────┐
│ unmodified       │  ── MMIO ────→ │                  │
│ vendor driver    │  ←── DMA ───── │                  │
│                  │  ← interrupt ─ │                  │
└──────────────────┘                └──────────────────┘
                       (VMM not on data path)
```

For pass-through to be safe, two hardware mechanisms must be in place:

- **The IOMMU** (Intel VT-d, AMD-Vi) confines the device's DMA to the guest's allocated memory. Without it, a malicious or buggy guest could direct the device to DMA anywhere in physical memory.
- **Interrupt remapping** routes the device's interrupts to the guest's vCPU rather than to the host. With **posted interrupts**, this can happen without a VM-exit — the interrupt is delivered directly to a guest vCPU running in non-root mode.

Pass-through delivers near-native performance — within a few percent of bare hardware on most workloads — at the cost that the device is monogamous (one guest at a time) and that live migration becomes difficult (the device's state lives in real silicon, not in software the VMM can serialize).

### SR-IOV

**Single-Root I/O Virtualization (SR-IOV)** lets a single physical device present itself as many independent **virtual functions (VFs)**, each of which can be assigned to a different guest. The device's silicon implements the multiplexing — separate queues, separate MAC addresses (for NICs), separate doorbell registers — and each VF is, from a guest's perspective, an independent device that can be passed through using the same VFIO mechanism as a single-device pass-through.

```
                    SR-IOV-capable physical device
                ┌────────────────────────────────────┐
                │ PF (physical function, host-managed)
                │  ┌────┐  ┌────┐  ┌────┐  ┌────┐    │
                │  │ VF │  │ VF │  │ VF │  │ VF │    │
                │  └────┘  └────┘  └────┘  └────┘    │
                └────┬──────┬──────┬──────┬──────────┘
                     │      │      │      │
                  guest1  guest2  guest3  guest4
```

SR-IOV is the standard mechanism for high-throughput virtualized networking and storage. The physical function (PF) on the host configures the device and partitions resources among VFs; each VF is then assigned to a guest via VFIO. Multiplexing happens in the device, isolation is enforced by the IOMMU, and the VMM is involved only in setup.

The trade-off is hardware dependence (only specific devices support SR-IOV, typically server-grade NICs and NVMe drives) and inflexibility (the number of VFs is fixed in silicon; live migration remains difficult). For workloads that fit, the performance is close to bare metal.

## A Note on GPU Virtualization

GPU virtualization deserves brief separate treatment because it does not fit cleanly into any of the three categories above. Three approaches coexist in practice:

- **`virtio-gpu`** is the paravirtual approach: a guest driver targets a virtio-class GPU device, and the VMM forwards graphics commands to a host backend (often via VirGL or Venus for OpenGL/Vulkan). It works for any guest with a virtio-gpu driver but exposes only a subset of GPU features and pays the usual virtio command-translation cost.
- **Mediated pass-through** (Intel GVT-g, NVIDIA vGPU) is a hybrid: the host GPU presents multiple virtual functions, but unlike SR-IOV the VFs are not autonomous — the host driver mediates command submission while letting the guest map command buffers and framebuffers directly. This trades full pass-through performance for the ability to share a single GPU across multiple guests.
- **MIG (Multi-Instance GPU)** on recent NVIDIA datacenter GPUs goes further toward true SR-IOV-style partitioning, presenting hardware-isolated GPU slices.

The space is qualitatively different from network/block I/O: GPU workloads are command-stream-heavy (latency- and throughput-sensitive on submission), state-rich (large framebuffers and command buffers), and tightly coupled to a vendor-specific driver stack. As a result, virtualization mechanisms that work well for storage and networking translate poorly. GPU virtualization is an active research and engineering area that this survey treats as out of scope beyond this note.

## Comparison and Composition

The three approaches occupy different points on a flexibility/performance trade-off:

| | Full Emulation | Virtio (Paravirtual) | Pass-through / SR-IOV |
|---|---|---|---|
| Guest modification | none | paravirtual driver | none (uses real device driver) |
| VMM on data path | every access | shared ring + notifications | not at all |
| Performance | poor (10–30% of native) | good (often >90%) | near-native (>95%) |
| Compatibility | universal | wide (driver required) | device must support, guest driver must exist |
| Live migration | trivial | trivial | difficult |
| Multi-tenant on one device | trivial | trivial | only with SR-IOV |
| Typical use | legacy, low-rate, fallback | the universal default | high-throughput, performance-critical |

In production, all three coexist. A typical guest might use:

- A virtio-net NIC for general-purpose networking,
- An SR-IOV VF for a latency-sensitive service,
- An emulated serial console for boot and debug,
- An emulated CD-ROM for one-time configuration.

The VMM presents whichever interface fits the device's role; the guest sees a heterogeneous set of devices and uses each through whichever driver is appropriate.

## Interrupts on the I/O Path

Every I/O technique above generates interrupts: emulated device interrupts, virtio completion interrupts, pass-through device interrupts. How those interrupts reach the guest vCPU is itself a topic with several layers of optimization.

The naive path injects an interrupt by causing a VM-exit, having the VMM update the virtual interrupt-controller state, and resuming the guest. The exit cost — measured in hundreds to thousands of cycles — is paid on every interrupt.

Two hardware features eliminate the exit:

- **APIC virtualization (APICv)** lets the hardware handle most local APIC accesses (`EOI` writes, ICR writes for IPIs) without a VM-exit.
- **Posted interrupts** let an external interrupt be delivered directly to a guest vCPU running in non-root mode by writing the interrupt vector into a hardware-accessible posted-interrupt descriptor and signalling the target pCPU. The guest sees the interrupt immediately; no VMM mediation is required. The processor-side variant (APICv, 2013) handles IPIs and virtual interrupts; the **VT-d** variant (2016) is what makes direct device-interrupt delivery possible.

Combined with SR-IOV and IOMMU interrupt remapping, posted interrupts allow a guest to receive interrupts from a real device with no software path through the VMM at all. This is the architectural counterpart on the completion path of what SR-IOV does on the submission path: take the VMM out of the loop.

For high-rate devices, **polling** is sometimes preferred over interrupts altogether. A guest (or the vhost backend) busy-polls a virtqueue or a device queue, eliminating interrupt cost at the price of CPU spend. Polling is the standard mode for DPDK-style packet processing and for storage stacks (SPDK, io_uring with polling).

## What this section established

I/O virtualization spans three approaches that occupy different points on the flexibility/performance trade-off. Full emulation presents real-hardware interfaces to the guest at the cost of one VM-exit per register access; it is the universal fallback. Paravirtual I/O (`virtio`) replaces the device interface with a shared-memory ring optimized for batched, low-overhead virtualization, and is the universal default in modern hypervisors. Direct assignment and SR-IOV give the guest a real device or a hardware-managed slice of one, taking the VMM out of the data path entirely at the cost of flexibility and migration. The three coexist in any non-trivial deployment.

Across all three, the dominant performance concerns are reducing the number of VM-exits on submissions and the number of interrupt injections on completions. The hardware features that close those gaps — IOMMU, SR-IOV, APICv, posted interrupts — together let a well-configured guest do device I/O with the VMM essentially absent from the data path.

The next section, [Cross-Domain Communication](/virtualization/communication/), generalizes the question: regardless of whether the communication is guest-to-VMM (as here) or guest-to-guest or driver-domain-to-driver-domain (as in disaggregated VMMs), what mechanisms carry data across an isolation boundary, and what determines their cost?
