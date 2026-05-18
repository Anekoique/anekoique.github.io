---
date: '2026-05-17T11:00:00+08:00'
draft: false
title: 'Virtualization Series 08 — VM Management and Cloud Extensions'
slug: 'vm-management'
tags: ["Virtualization", "Hypervisor", "Systems", "Cloud"]
series: ["Virtualization Series"]
summary: "The operational layer: lifecycle, snapshotting, pre-copy / post-copy live migration, high-availability replication (Remus), microVMs (Firecracker), and fleet orchestration. How operational requirements shape VMM architecture."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The previous sections examined the mechanisms by which a single VM executes: how its CPU, memory, devices, and cross-domain interactions are virtualized. This section looks at the surrounding *operational* layer — the mechanisms by which VMs are created, configured, suspended, snapshotted, migrated, replicated, and destroyed; and the cloud-scale extensions of those mechanisms (microVMs, fleet orchestration) that have shaped modern virtualization more than any other recent development.

These topics are not purely engineering details. The shape of the management layer drives the shape of the underlying VMM: KVM's hosted architecture exists in part because reusing the Linux operational stack was easier than building a parallel one; Firecracker's minimal device set exists because the management requirements of serverless workloads (cold-start latency, density, security) made the cost of legacy device emulation unacceptable. *How VMs are managed shapes how VMs are built.*

## The VM Lifecycle

A VM passes through a sequence of states from creation to destruction. The states are roughly the same across hypervisors; the operations between them are where the design choices live.

```
   defined ──create──→ stopped ──start──→ running
                          ↑                  │
                          │              suspend
                          │                  ▼
                       resume ←───────── suspended
                          │
                       destroy
                          ▼
                       deleted
```

### Definition and creation

A VM is **defined** by a configuration: vCPU count, memory size, attached devices, boot disk, network interfaces. Definition is a specification, not yet an instantiation. The configuration may live in a configuration file (libvirt XML, Firecracker JSON), in a database (cloud control plane), or be passed inline at creation (`virsh`, `gcloud`).

**Creation** instantiates the configuration: the VMM allocates the data structures for the VM's vCPUs and memory regions, opens device backends, loads any required firmware images, and brings the VM to the *stopped* state — ready to start but not yet executing.

The cost of creation has historically been small relative to other lifecycle costs. The microVM era has changed this: when VMs are created in response to incoming requests (serverless), creation latency directly impacts user-visible request latency, and reducing it from seconds to milliseconds has been a substantial engineering effort.

### Boot

**Booting** transfers control to the guest. Two things happen first: the VMM must place a *boot image* in the VM's memory and arrange for the vCPU to start executing it.

The traditional path goes through firmware: the VMM loads a virtual BIOS or UEFI, the firmware initializes the virtual hardware (probing devices, building memory maps), reads a bootloader from disk, the bootloader loads the kernel, and the kernel takes over. This is universal but slow — firmware initialization is a significant fraction of the boot path, and it does work that, in a controlled VMM environment, is not strictly necessary.

The microVM path skips most of this. Firecracker, for example, has no BIOS and no PCI bus enumeration: the VMM places a Linux kernel image directly into guest memory, configures the vCPU's initial register state to mimic what a Linux bootloader would set up, and starts the vCPU at the kernel entry point. The boot completes in tens of milliseconds rather than seconds.

The trade-off is generality: skipping firmware works only if the guest is willing to be loaded this way. For a single, controlled OS (Linux in serverless), this is fine; for arbitrary guests, the firmware path is unavoidable.

### Suspend and resume

A **suspended** VM has its full state captured in the VMM but is not executing. The suspend operation pauses all vCPUs, captures their architectural state, and (depending on implementation) either keeps the VM's memory in place or writes it to backing storage. **Resume** reverses the operation: the memory is brought back, the vCPU state is restored, and execution continues.

Suspend/resume is the simplest of the state-management operations and the foundation for the more complex ones (snapshot, migration). The fast path keeps memory in place; the slow path serializes the entire VM to disk.

### Destroy

**Destroying** a VM deallocates its resources: memory is returned to the host, device backends are closed, the VM's data structures are removed. In a cloud setting, destruction may also involve releasing storage, unbinding network attachments, and updating the control plane's accounting.

## Snapshotting

A **snapshot** captures a VM's complete state at a point in time so it can be inspected, rolled back to, or cloned. Three styles of snapshot appear, distinguished by what they include and when they cost what:

- **Disk-only snapshot.** Captures only the VM's persistent storage, using copy-on-write at the storage layer (qcow2, ZFS, LVM, btrfs). The VM does not pause; on rollback, only disk state reverts (memory and device state are lost). Cheap and common.
- **Full-state snapshot.** Captures memory and vCPU state in addition to disk. The VM must pause briefly while the memory is captured (typically by COW-marking it and continuing the VM, then writing the COW pages out lazily). Rollback restores a fully resumable VM. More expensive but more complete.
- **External snapshot.** A backup-style snapshot taken without VM cooperation, typically by tracking dirty pages in the second-stage page table and incrementally copying them out. This is the mechanism live migration is built on; in standalone form it produces a portable VM image.

Snapshots are operationally useful (rollback for testing, fork for parallel exploration) and security-relevant (forensic capture of a compromised VM, time-travel debugging). Their incremental form is the building block for the more demanding operation of live migration.

## Live Migration

**Live migration** moves a running VM from one physical host to another with minimal interruption to the guest. It is one of the most distinctive capabilities of system virtualization — there is no comparable operation for a process or a container — and is the basis of cloud-scale operations like load balancing, hardware maintenance, and consolidation.

### Pre-copy migration

The dominant approach is **pre-copy**: the VMM copies the VM's memory to the destination host *while the VM continues to run* on the source, tracking which pages are modified during the copy. After the initial copy, dirty pages are re-copied. After several iterations, the dirty rate falls (or a deadline is reached); the VM is paused, the residual dirty pages and vCPU state are copied, and the VM resumes on the destination.

```
   source                                  destination
   ┌──────────────────┐                  ┌──────────────────┐
   │ VM running       │                  │                  │
   │ ───── full copy ──────────────────→ │ memory           │
   │ VM running       │                  │                  │
   │ ──── dirty pages ──────────────────→│ memory + dirty   │
   │ ...                                 │                  │
   │ VM paused        │                  │                  │
   │ ─ final dirty + vCPU state ────────→│                  │
   │                  │                  │ VM resumes ──────│
   └──────────────────┘                  └──────────────────┘

         time on source ━━━━━━━━━━━━━━━━━━━━━━━ time on dest
                                       │
                                  downtime (ms)
```

The downtime — the interval during which the VM is paused — is typically tens to low hundreds of milliseconds for a well-behaved guest (60–210 ms in the original [Live Migration of Virtual Machines](https://www.usenix.org/conference/nsdi-05/live-migration-virtual-machines) measurements (Clark et al., NSDI 2005), with worst-case multi-second downtime under heavy write load), well under the threshold at which TCP connections time out or interactive users notice. The total migration time is dominated by the size of memory and the available network bandwidth.

The corner cases are where the engineering lives:

- **Dirty rate exceeds copy rate.** If the guest is dirtying memory faster than it can be copied, pre-copy never converges. Hypervisors throttle the guest's CPU as a last resort.
- **External device state.** Pass-through devices have state in real silicon that the VMM cannot capture; SR-IOV with stateful flow tables is similarly difficult. Live migration is one of the strongest operational reasons to prefer paravirtual I/O over pass-through.
- **Network attachment.** The VM must keep its IP address; this requires the destination host to be on the same L2 segment, or the use of overlay networks (VXLAN, Geneve) that decouple guest networking from physical topology.

### Post-copy migration

The alternative is **post-copy**: pause the VM briefly, copy the vCPU state and a minimal memory subset, resume on the destination, then fault remaining pages in from the source on demand. Total migration time is shorter, but performance during the migration is degraded (every cold page is a network fault), and a network failure during the post-copy window can leave the VM unrecoverable.

Post-copy is rarely used standalone but combines well with pre-copy: pre-copy until the dirty rate stabilizes, then post-copy to close out. Modern KVM and Xen support this hybrid mode.

## High Availability and Replication

Live migration moves a VM intentionally; **high availability** is about surviving an unintentional move — a host failure that destroys the source.

The straightforward approach is **periodic checkpointing**: snapshot the VM regularly, ship the snapshot to a backup host, and on failure resume from the most recent snapshot. The cost is the work between snapshots is lost; the cadence trades against the consistency guarantee.

**Continuous replication** ([Remus](https://www.usenix.org/conference/nsdi-08/remus-high-availability-asynchronous-virtual-machine-replication) is the canonical example) takes this further: snapshot at high frequency (25–100 ms intervals; 10–40 Hz in the original Cully et al. NSDI 2008 evaluation), with output buffering between snapshots so that no externally visible action is committed until the corresponding state has been replicated. On failure, the backup resumes with no observable inconsistency — at the cost of substantial steady-state overhead, both in the snapshot rate and in the output latency added by buffering.

Both approaches are uncommon in commodity cloud deployments. The dominant pattern is to push high availability up the stack: applications are designed to tolerate VM loss (through their own replication, queues, retry logic), and the infrastructure simply restarts the failed VM somewhere else. Per-VM HA, when used, is reserved for workloads where the application cannot be made fault-tolerant — typically legacy systems running on virtualized infrastructure for compatibility rather than design.

## Cloud-Scale Extensions

The lifecycle and migration operations above were largely developed in the consolidation era (2000s), when the typical workload was a small number of long-running VMs. Cloud computing has placed two new pressures on the management layer that have, in turn, reshaped the VMM.

### MicroVMs

**MicroVMs** are VMMs designed for serverless and container-replacement workloads, where each VM hosts a single short-lived application and the relevant performance metrics are cold-start latency, memory footprint, and per-host density. The canonical example is [Firecracker](https://www.usenix.org/conference/nsdi20/presentation/agache) (AWS, 2017); related designs include Cloud Hypervisor and `crosvm`.

MicroVM design choices uniformly favour minimalism:

- **No legacy device emulation.** Only `virtio` devices, no PCI, no BIOS, no USB.
- **Direct kernel boot.** Skip firmware; load the kernel directly into memory.
- **Reduced device set.** Only the devices actually needed (network, block, vsock, serial); no graphics, no sound, no ATA.
- **Minimal VMM codebase.** Firecracker is around 50,000 lines of Rust; QEMU is over a million lines of C.

The result is cold-start of roughly 125 ms (NSDI 2020 measurement; the VMM-internal startup is faster, but the user-visible cold-start includes guest boot), per-VM memory footprint under 5 MiB, and a TCB an order of magnitude smaller than a general-purpose VMM. The price is generality — microVMs cannot run arbitrary guests with arbitrary device requirements; they run Linux-shaped workloads.

The microVM design philosophy generalizes: take the assumption that the guest is cooperating and well-behaved, and use that assumption to strip away mechanisms that exist only to support hostile or unknown guests.

### Fleet orchestration

At the other end of the scale, cloud infrastructure manages VMs at fleet level: thousands to millions of VMs across thousands of physical hosts, with operations (scheduling, migration, maintenance) coordinated by a central control plane. Kubernetes for container-based workloads, OpenStack and AWS/GCP/Azure proprietary control planes for VM-based ones.

This layer is mostly outside the scope of this survey, but two of its requirements feed back into VMM design:

- **Operations must be programmable.** Every lifecycle action (`create`, `start`, `migrate`, `snapshot`, `destroy`) must be available via API, with predictable success/failure semantics. This drove hypervisors to expose REST/gRPC interfaces and made libvirt-style abstractions standard.
- **Operations must be observable.** Per-VM CPU, memory, network, disk, and event metrics must be exported continuously. Hypervisors now contribute substantial telemetry — and the cost of generating it is itself a factor in VMM design.

The interaction between fleet orchestration and per-VM mechanisms is bidirectional and shapes both: cloud requirements drive what the VMM exposes, and what the VMM can expose constrains what cloud orchestration can do.

## What this section established

The operational layer of virtualization — the lifecycle, snapshotting, live migration, high availability, and cloud-scale orchestration of VMs — is one of the largest factors that distinguishes virtualization from other isolation techniques (no comparable operations exist for processes or containers). The mechanisms have evolved substantially: pre-copy live migration enabled cloud-scale operational flexibility, microVMs adapted virtualization to serverless workloads by stripping legacy mechanisms, and fleet orchestration has driven hypervisors toward more programmable, more observable interfaces.

The shape of this operational layer feeds back into VMM architecture. The microVM trajectory in particular — minimal device sets, direct kernel boot, small Rust-based VMMs — is the closest production precedent for the leanest end of the VMM design space.

The next section, [Performance and Overhead](/virtualization/performance/), pulls together the cost themes that have appeared throughout this survey and asks what virtualization actually costs, where the costs come from, and how the answers have changed as hardware and software have evolved.
