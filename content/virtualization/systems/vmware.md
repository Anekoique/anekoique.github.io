---
date: '2026-06-27T18:00:00+08:00'
draft: false
title: 'Virtualization Systems — VMware (ESXi)'
slug: 'vmware'
tags: ["Virtualization", "Hypervisor", "Systems", "VMware"]
series: ["Virtualization Series"]
summary: "The canonical commercial monolithic Type-1 hypervisor. VMkernel as a specialized OS holding scheduler, storage, network, drivers, and per-VM vmm worlds; lineage from Disco (1997) to Workstation (1999) to ESX (2001); inventor of memory overcommit (TPS, ballooning, hypervisor swap)."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

VMware is the **canonical commercial virtualization vendor** — the company that proved x86 virtualization could be practical (Workstation, 1999), shipped the first production monolithic Type-1 hypervisor (ESX, 2001), and invented most of the memory-overcommit techniques the rest of the industry later copied. This note covers primarily **VMware ESXi**, the modern bare-metal hypervisor, but includes a historical section on **VMware Workstation** because the binary-translation techniques developed there in the late 1990s are what made x86 virtualization possible at all, and the rest of the survey's chapters lean on that lineage.

VMware was founded in 1998 by Stanford researchers (Diane Greene, Mendel Rosenblum, Edouard Bugnion, and others) building on [Disco](https://dl.acm.org/doi/10.1145/268998.266672) (Bugnion et al., SOSP 1997, MIPS-based research VMM). The company shipped Workstation in 1999 and ESX in 2001. The merger that became ESXi (architectural integration of the management plane in 2007) is the product still sold today. VMware was acquired by EMC (2003), then Dell (2016), then Broadcom (2023) — under Broadcom, the licensing model has shifted toward larger enterprise customers and the ESXi free edition was discontinued (early 2024), reshaping the market position.

What makes VMware worth reading in a virtualization survey — and what makes this note structurally different from every other system note here — is that VMware is the only **closed-source** system in the survey, *and* the only production realization of the **monolithic Type-1 hypervisor** shape that [§03](/virtualization/vmm-architecture/) names. The closed-source aspect means citations are to published papers and official whitepapers rather than to source code. The monolithic-Type-1 aspect means VMware fills the §03 case-study slot that Xen (disaggregated), hvisor (separation kernel), and AxVisor (unikernel-application) don't.

This note follows the structure established in earlier notes — VMware's actual architecture, not a forced §-template. Source grounding is to: [Disco](https://dl.acm.org/doi/10.1145/268998.266672) (Bugnion et al., SOSP 1997), [Memory Resource Management in VMware ESX Server](https://www.usenix.org/conference/osdi-02/memory-resource-management-vmware-esx-server) (Waldspurger, OSDI 2002), and [A Comparison of Software and Hardware Techniques for x86 Virtualization](https://dl.acm.org/doi/10.1145/1168857.1168860) (Adams & Agesen, ASPLOS 2006), plus VMware's public technical white papers. Where details aren't publicly documented, the note says so.

## §02 — Taxonomy: ESXi at a glance

| Axis | VMware ESXi |
|---|---|
| Placement | **Type-1 bare-metal monolithic** — VMkernel runs directly on hardware; no host OS; all virtualization functionality (VMM, scheduler, storage, network, management) is in the same privileged binary |
| Guest interface | **Full virtualization** with optional paravirt accelerators (VMware Tools) — unmodified guests work, cooperating guests get virtio-equivalent drivers (VMXNET3 for network, PVSCSI for storage, balloon driver for memory reclaim) |
| Hardware support | **Required** in modern versions: VT-x/AMD-V + EPT/NPT; VT-d/AMD-Vi for passthrough (DirectPath I/O); SR-IOV for high-performance NICs; nested-virt supported (limited) |
| Isolation boundary | **Hardware** (per-VM EPT/NPT + VMX non-root mode) at the VM boundary; VMkernel is the single privileged layer that all VMs share |

The defining structural choice is **single privileged binary**. Where Xen splits the privileged surface across hypervisor + dom0 (see [Xen](/virtualization/systems/xen/)), and KVM uses the host Linux kernel as the privileged base (see [KVM](/virtualization/systems/kvm/)), ESXi puts *everything* — VMM, scheduler, memory manager, storage stack, network stack, device drivers, management agents — into one binary called the VMkernel. There is no general-purpose OS underneath; VMkernel is the OS, specialized entirely for running VMs.

Three rules to internalize:

1. **ESXi is the [§03](/virtualization/vmm-architecture/) monolithic shape, not the disaggregated shape Xen took.** §03 names three architectural shapes (monolithic, hosted, disaggregated). Xen famously chose disaggregated. ESXi famously chose monolithic. The decision shapes everything downstream: ESXi has no dom0-equivalent, so device drivers must live in the VMkernel; storage and network stacks must be in the VMkernel; management must be in the VMkernel (or as small in-VMkernel processes communicating with external management plane). This is the *production* monolithic VMM the survey's §03 references.
2. **VMware invented practical x86 virtualization.** Before Workstation in 1999, x86 was widely believed un-virtualizable due to the Popek-Goldberg gap — 17 sensitive non-privileged instructions that prevented strict trap-and-emulate. VMware's binary translation technique closed the gap in software. The Adams-Agesen paper documents the comparison between this software approach and the later hardware approach (VT-x); the survey's [§04](/virtualization/cpu/) relies on this lineage.
3. **VMware invented most of memory overcommit.** Content-based page sharing, ballooning, and hypervisor-level swapping all came from VMware's ESX work (2001-2002), documented in the ESX memory paper. Every subsequent VMM that supports memory overcommit (KVM via KSM, Xen, Hyper-V) implements the same three mechanisms; VMware was first.

## Two products, one architectural family

VMware's two production hypervisors are very different in placement but share design DNA:

| Product | Placement | First released | Use case | Status (2026) |
|---|---|---|---|---|
| **VMware Workstation** (Linux) / **Fusion** (macOS) | Type-2 hosted | 1999 / 2007 | Desktop / dev VMs | Maintained; "Pro" tier now free for personal use as of 2024 |
| **VMware ESX** → **ESXi** | Type-1 bare-metal monolithic | 2001 / 2007 (-i) | Server / datacenter | Maintained; Broadcom shifted to subscription / enterprise-only |

Both share:
- The VMM core (the per-guest VMM instance, called "vmm" — handles vCPU + memory virtualization for one guest).
- Many device-emulation implementations.
- VMware Tools (the in-guest paravirt drivers + utilities).
- Snapshot/clone semantics.
- The vmdk disk image format.

They differ in:
- **What's below the VMM.** Workstation runs on a host OS (Linux for Workstation, macOS for Fusion); ESXi runs on bare metal via the VMkernel.
- **Scheduling.** Workstation's vCPU threads are host-OS-scheduled; ESXi's VMM threads are VMkernel-scheduled (and the VMkernel scheduler is one of the best-tuned commercial schedulers in existence).
- **Device drivers.** Workstation uses the host OS's drivers (it just sees them as Linux/macOS interfaces); ESXi has its own driver model (VMkernel native modules, plus a compatibility shim for some Linux drivers).
- **Management.** Workstation has a desktop GUI; ESXi has Direct Console UI (DCUI) + ESXi Shell + remote SSH + the vSphere management plane.

This note focuses on ESXi for the [§03](/virtualization/vmm-architecture/) case-study purpose, with a historical Workstation section covering the binary-translation breakthrough that bootstrapped the whole VMware product family.

## Historical: Workstation and the binary translation breakthrough

[A Comparison of Software and Hardware Techniques for x86 Virtualization](https://dl.acm.org/doi/10.1145/1168857.1168860) (Adams & Agesen, ASPLOS 2006) is the canonical reference for what VMware Workstation did before VT-x existed. Workstation 1.0 shipped in 1999, three years before Intel's VT-x announcement, and proved x86 virtualization was possible without hardware support.

### The x86 virtualization gap

Recall from [§04](/virtualization/cpu/): x86 had **17 sensitive non-privileged instructions** — instructions that exposed CPU state but didn't trap when executed at non-zero rings. Examples:
- `POPF` (pop flags): silently ignores changes to the IF (interrupt enable) flag at ring > 0, instead of trapping.
- `SMSW` (store machine status word): readable at any ring; exposes CR0 contents.
- `SIDT` / `SGDT` / `SLDT` / `STR`: read interrupt descriptor table / GDT / LDT / task register at any ring.
- `LAR` / `LSL`: load access rights / segment limit — read segment descriptor info at any ring.
- `MOV from segment register` (`PUSH CS`, `PUSH DS`, …): reads ring level from segment selectors.

Trap-and-emulate (the classical Popek-Goldberg technique) doesn't work because these instructions don't trap. The guest can issue them and observe state that should be hidden.

### Binary translation as the fix

Workstation's solution: don't run guest privileged code natively. Instead, *translate* it into safe substitutes before executing. The technique:

- **Guest user code runs natively** at ring 3 on the host CPU. User code doesn't issue the problematic instructions in normal workloads, so it can run unmodified.
- **Guest kernel code is binary-translated** by a dynamic translator into a code cache. The translator scans guest kernel basic blocks, identifies sensitive instructions, and replaces them with safe equivalents (typically calls into VMM code that emulates the instruction's effect on virtual CPU state).
- **The translated code is cached** so each guest basic block is translated only once. Hot loops run from the cache at near-native speed.
- **Memory virtualization is done via shadow page tables.** The guest believes it manages its own page tables; the VMM maintains a parallel set of "shadow" page tables that the CPU actually walks, mapping guest virtual to host physical addresses. Guest page-table writes trap (via marking guest PT pages as read-only) and the VMM updates shadows.

This is structurally similar to what QEMU's TCG does for cross-architecture emulation (see [QEMU](/virtualization/systems/qemu/) §6) — both are dynamic binary translators with code caches — but Workstation's BT was tuned for the *same-architecture* case (x86 guest on x86 host), so most instructions could be copied verbatim. Only the sensitive ones needed rewriting. The Adams-Agesen paper notes that Workstation's BT achieves close to native speed for many workloads, with the overhead concentrated in the translation step (paid once per basic block) and in the few rewritten instructions.

### Why it mattered

Three reasons:
1. **It proved x86 virtualization was practical.** Before Workstation, "x86 can't be virtualized" was conventional wisdom. After, it was clearly possible.
2. **It bootstrapped the commercial market.** ESX (server, 2001) and Workstation (desktop, 1999) gave VMware a head start in production virtualization that lasted ~7 years until Xen + KVM caught up.
3. **It still works today.** Even after VT-x and AMD-V shipped, VMware kept BT alive in Workstation/ESX for cases where hardware virt was disabled, missing, or buggy. The Adams-Agesen paper found cases where BT was actually *faster* than the first-generation VT-x because BT could batch translations and avoid VM-exits that early VT-x couldn't.

The lineage from Disco (1997) → Workstation (1999) → ESX (2001) is what made VMware the dominant virtualization vendor by the mid-2000s. Hardware virtualization (VT-x, 2005) and the open-source competitors (Xen 2003, KVM 2007) eventually caught up, but VMware had a sustained technical lead through the formative period.

## The ESXi architecture

ESXi is, structurally, **one privileged binary** (the VMkernel) plus a small set of management agents that run as VMkernel processes plus per-guest VMM instances.

```
                 Hardware (CPU, memory, NIC, HBA, disk, etc.)
                       │
                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  VMkernel (the monolithic privileged binary)                     │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Scheduler (CPU + memory + I/O)                             │  │
   │  │   - proportional-share with reservations and limits        │  │
   │  │   - co-scheduling for SMP guests                           │  │
   │  │   - NUMA-aware placement                                   │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Memory management                                          │  │
   │  │   - host-physical → machine-page mapping (pmap)            │  │
   │  │   - content-based page sharing (TPS)                       │  │
   │  │   - guest memory overcommit (ballooning, swap, compress)   │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Storage: VMFS + storage stack                              │  │
   │  │   - VMFS: cluster filesystem on SAN/iSCSI/NFS              │  │
   │  │   - PSA (Pluggable Storage Architecture): driver framework │  │
   │  │   - vSAN: hyperconverged distributed storage               │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Network: virtual switches + drivers                        │  │
   │  │   - vSwitch (standard) or vDS (distributed)                │  │
   │  │   - NIC drivers (native VMkernel modules)                  │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Device drivers (native + Linux compatibility shim)         │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Per-guest VMM instances ("vmm" processes)                  │  │
   │  │   - one per running VM; each handles its guest's:          │  │
   │  │     * vCPU virtualization (VT-x/AMD-V world-switch)        │  │
   │  │     * shadow / EPT page tables                             │  │
   │  │     * device emulation                                     │  │
   │  └────────────────────────────────────────────────────────────┘  │
   │                                                                  │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │ Management agents (hostd, vpxa, DCUI, sshd, etc.)          │  │
   │  │   - small daemons running as VMkernel processes            │  │
   │  │   - serve API for vSphere Client / vCenter                 │  │
   │  └────────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────────┘
```

A few structural observations to internalize before drilling in:

1. **There is no host OS.** VMkernel boots directly from the boot loader and *is* the OS — there's no Linux underneath, no separate microkernel underneath. This is what makes ESXi Type-1 and distinguishes it from Workstation (which runs on Linux/macOS) and KVM (which uses Linux as the host OS).
2. **Everything is in one binary.** Device drivers, schedulers, filesystems, network stack, management daemons — all link into the VMkernel. There's no equivalent of Xen's dom0 hosting drivers and management; ESXi puts all of that in-VMkernel. This is what makes it *monolithic* in the [§03](/virtualization/vmm-architecture/) sense.
3. **Per-guest VMM instances are not separate processes the way QEMU instances are.** They run as VMkernel "worlds" (the VMkernel's process-equivalent), sharing the same address space as the VMkernel itself. The isolation between a VM and the VMkernel is hardware (VMX non-root mode); the isolation between two VMs' vmm instances is logical (the VMkernel's scheduler keeps them apart).

### The VMkernel as an OS

The VMkernel is essentially a specialized operating system. It has:

- **Its own scheduler**, with concepts like CPU shares, reservations, limits, hyperthreading-aware placement, co-scheduling for SMP guests, NUMA-aware placement.
- **Its own memory manager**, doing the host-physical-to-machine-page translation, page sharing, ballooning, swapping, compression.
- **Its own filesystem** (VMFS — VMware's cluster filesystem) optimized for hosting large VM images on shared storage.
- **Its own network stack** with virtual switches.
- **Its own device driver model** (VMkernel native drivers), with a compatibility shim that lets some Linux drivers run with adaptation.
- **Its own task model** — VMkernel "worlds" are roughly analogous to Linux kernel threads.
- **Its own filesystem hierarchy** — `/vmfs/volumes/...`, `/etc/`, etc. — but it's not POSIX; you can shell into it (DCUI / SSH) but you're in a constrained busybox-derived environment, not a general-purpose OS shell.

The VMkernel is written primarily in C and a small amount of assembly. It is roughly **2-5 MLoC** based on public statements over the years; this is comparable to QEMU's userspace VMM (1.5 MLoC) plus KVM's kernel module (~75 KLoC), but rolled into one binary. The exact size is not public.

### Workloads as virtual machines

A running ESXi host has a few logical "worlds":

| World type | Examples |
|---|---|
| Idle world | One per pCPU; runs when nothing else does |
| Helper worlds | VMkernel internal threads (page sharer, balloon driver, etc.) |
| Driver worlds | Native VMkernel driver execution contexts |
| **vmm worlds** | **One per guest vCPU; handles the world-switch into and out of guest mode** |
| **vmx worlds** | **One per guest VM; userspace-ish auxiliary processes that handle device emulation, snapshot orchestration, control-plane interaction** |
| Management worlds | hostd, vpxa, DCUI, etc. |

The split between vmm and vmx is worth flagging: it's structurally similar to QEMU+KVM's split between the kernel module (vCPU run loop) and the userspace VMM (device models, control plane), but both vmm and vmx run inside the VMkernel — there's no kernel/userspace boundary the way Linux's KVM has. vmm is closer to the metal (handles VT-x exits) and vmx is more orchestration-flavored (handles snapshot operations, device emulation, attaching to monitoring).

## Memory overcommit — VMware's most lasting contribution

Of all the technologies VMware invented, memory overcommit is the one with the broadest legacy. [Memory Resource Management in VMware ESX Server](https://www.usenix.org/conference/osdi-02/memory-resource-management-vmware-esx-server) (Waldspurger, OSDI 2002) documents three mechanisms — content-based page sharing, ballooning, and hypervisor-level swapping — all of which were VMware originals and which every subsequent VMM has implemented in some form. The survey's [§05](/virtualization/memory/) references these techniques; this section is the case study.

### The motivation

A datacenter wants to run more VMs than the sum of their configured memory. If 10 VMs are configured with 8 GB each but their *working sets* total only 30 GB, a host with 32 GB RAM should be able to run all of them. The challenge: guests don't know their memory is overcommitted, and the hypervisor doesn't know what's important to the guest. ESX's three mechanisms attack different parts of the problem.

### Mechanism 1: Transparent Page Sharing (TPS)

The mechanism: the VMkernel periodically scans guest memory looking for **identical pages** (same contents, byte-for-byte). When found, the duplicates are deduplicated — both VMs are remapped to the same machine page, marked read-only. If either VM writes, copy-on-write splits them.

This works because many guests share content: kernel pages (multiple Linux VMs running the same kernel version), zero pages (uninitialized memory), common library pages (libc, glibc), framework code (.NET, JVM, etc.). The ESX memory paper reports 10-40% memory savings on typical workloads, with no guest cooperation required.

The mechanism:
- A background scanner walks pages, computing hashes (content fingerprints).
- Pages with matching hashes are byte-compared to confirm equality.
- Matching pages are merged: one machine page backs both guests' guest-physical pages.
- Writes trigger a page fault, the COW is broken, and the writer gets a private copy.

**Why it's no longer default-on.** In 2015, security researchers showed that TPS could be exploited as a side channel — an attacker VM could detect the presence of specific content in a victim VM by deduplication timing. VMware made TPS opt-in for cross-VM sharing (only same-VM sharing is on by default in modern versions). The same concern applies to Linux's KSM (which is the same idea, transferred from this VMware work) and is one of the reasons modern security-conscious cloud doesn't enable KSM.

The architectural contribution remains: *content-based memory deduplication is possible without guest cooperation*. KSM (Linux), Linux's transparent huge pages dedup, ZFS's compress-then-dedup all descend from this idea.

### Mechanism 2: Ballooning

The mechanism: a paravirt driver (the "balloon driver", `vmmemctl`) is installed in the guest OS as part of VMware Tools. When the host is under memory pressure, the VMkernel sends a "balloon up" command to the balloon driver, which allocates pages from the guest's free list. Those pages are now owned by the driver and inaccessible to the rest of the guest OS — the guest's own page allocator hands them out only via the balloon driver. From the host's perspective, those pages are now free (the balloon driver doesn't touch their content), so the VMkernel can reclaim them and use them for other VMs.

When pressure subsides, "balloon down" frees the pages back to the guest.

The clever part: **the guest OS chooses which pages to give up**, because it's the guest's own allocator that's queried for pages. The guest will naturally give up pages it considers least valuable (clean cached pages, idle process pages). This is much better than the hypervisor trying to guess what's important.

The cost: the guest must have VMware Tools installed and the balloon driver loaded. Without it (e.g., during boot, or for guests without Tools), the hypervisor must fall back to mechanism 3.

Ballooning is the **paravirt cooperation** of memory overcommit. Linux's KVM uses virtio-balloon for the same purpose; Xen has its own balloon driver; Hyper-V has Dynamic Memory. All descend from VMware's mechanism.

### Mechanism 3: Hypervisor-level swapping

When ballooning isn't available or isn't enough, the VMkernel falls back to direct swapping: pick guest pages, write them to disk, mark them as not-present in EPT, and reclaim the machine pages.

The cost is significant — uncooperative reclaim doesn't know what's hot, so it can swap out actively-used pages, causing severe performance degradation. ESX's memory manager prioritizes ballooning over swapping for this reason, and the [VMware paper](https://www.usenix.org/conference/osdi-02/memory-resource-management-vmware-esx-server) documents the heuristics: idle taxation (high-idle VMs get reclaimed from first), share-based reclamation (lower-share VMs get reclaimed from first), gradual rather than sudden swapping.

**Memory compression** was added in ESX 4.1 (2010) as an intermediate step: instead of swapping a page to disk, compress it in memory. If the compression ratio is good (>50%), keep it in memory in compressed form; otherwise swap. This adds back some performance at the cost of CPU.

### The hierarchy

In modern ESXi, the reclaim order under pressure is roughly:
1. Page sharing (TPS) — if enabled, runs continuously.
2. Ballooning — if VMware Tools is present and the balloon driver responds.
3. Memory compression — if pressure persists.
4. Hypervisor swapping — last resort.

Each step is more expensive than the last but reclaims more memory. The VMkernel monitors host free-memory thresholds (TPS-only at >6%, +balloon at <6%, +compress at <4%, +swap at <2% by default) and escalates dynamically.

### Why this design has lasted

Three reasons the ESX memory model has stayed influential:
- **It works without guest changes for the universal mechanism (TPS, swap)**, and with optional guest cooperation for the better mechanism (balloon).
- **The mechanisms compose.** Each is independent, can be on/off, and the order of preference is clear.
- **It hits a real economic need.** Datacenter memory is expensive; overcommit ratios of 1.5-2x are common in production. Even modest overcommit savings translate to large hardware cost reductions.

KVM, Xen, and Hyper-V all implemented analogous mechanisms because they had to compete with ESX. The architectural pattern came from VMware.

## CPU virtualization in ESX/ESXi

ESX historically supported all three approaches:

1. **Binary translation** (the Workstation lineage) — pre-VT-x, software-only.
2. **Hardware-assisted with shadow page tables** — VT-x but no EPT (Nehalem and earlier).
3. **Hardware-assisted with EPT/NPT** — modern.

By modern ESXi releases, BT is deprecated for normal use and the hardware paths are universal. The [Adams-Agesen paper](https://dl.acm.org/doi/10.1145/1168857.1168860) compares BT to first-gen VT-x and finds them comparable; second-gen VT-x with EPT decisively beats BT (because EPT removes shadow page table maintenance, which was the main BT cost on memory-intensive workloads).

### The vmm world

Each guest vCPU runs in a VMkernel "vmm" world. The vmm:
- Sets up VMCS / VMCB structures.
- Issues `VMLAUNCH` / `VMRESUME` to enter guest mode.
- Handles all VM-exits: dispatches privileged-instruction emulation, page-fault handling, I/O, interrupt injection.
- Maintains the EPT (or shadow page table, in legacy mode).

The vmm is *part of the VMkernel*, not a separate userspace process. This is the structural contrast with KVM+QEMU: KVM's vCPU loop is in the kernel module; QEMU's vCPU thread is in userspace; together they make up the "VMM" for one VM. ESXi merges these into the VMkernel itself.

### Scheduling

The VMkernel scheduler is one of the better-tuned commercial schedulers. Key features:
- **Proportional share with reservations and limits.** Each VM has CPU shares (relative priority), CPU reservation (minimum guaranteed MHz), CPU limit (maximum allowed MHz).
- **Co-scheduling for SMP guests.** When a guest has N vCPUs, the scheduler tries to run all N simultaneously on N pCPUs. This avoids the *lock-holder preemption* problem where a guest spinning on a lock can be wasted CPU because the lock-holder is descheduled.
- **NUMA-aware placement.** vCPUs are placed on the same NUMA node as their guest's memory.
- **Hyperthread management.** The scheduler distinguishes physical CPUs from hyperthread siblings and handles them appropriately (e.g., a guest with `latency-sensitive` setting gets full physical CPUs, not shared siblings).
- **Power management integration.** P-state and C-state coordination with hardware.

The scheduler is the only commercial-grade VM scheduler that ships as part of a single integrated product. Xen's scheduler (Credit2) is also well-tuned but is part of an open-source ecosystem; KVM's "scheduler" is just the Linux CFS, which doesn't know about co-scheduling.

## Storage: VMFS and the storage stack

VMFS (Virtual Machine File System) is VMware's cluster filesystem, designed specifically for the workload of "many large VM disk images on shared storage". It's the storage substrate for VM disk files (`.vmdk` files).

### What VMFS provides

- **Cluster file system semantics.** Multiple ESXi hosts can mount the same VMFS volume on shared storage (Fibre Channel SAN, iSCSI, NFS in the case of NFS-style sharing). Concurrent access is coordinated by VMFS's locking.
- **Optimized for large files.** VMFS uses very large block sizes (1 MB by default; 8 MB available) to keep metadata overhead low for large VM disks.
- **VAAI (vSphere APIs for Array Integration).** VMFS offloads operations (block zeroing, copy, locking) to the storage array when the array supports it. This dramatically speeds up VM clone, snapshot, and provisioning.
- **Atomic test-and-set locks.** Used to coordinate between hosts on shared storage.

VMFS predates and significantly influenced cluster filesystems like Ceph and GlusterFS; the optimization for the "large file workload" was novel and important.

### Pluggable Storage Architecture (PSA)

The storage stack in ESXi is modular via PSA. The framework has:

- **NMP** (Native Multipathing Plugin): the default multipath module; handles path selection and failover for SAN/iSCSI.
- **VAAI plugins**: array-specific offload modules.
- **VVOLs** (Virtual Volumes): a model where VM-disk semantics extend down to the storage array; the array knows about per-VM operations.
- **Third-party plugins**: storage vendors (EMC, NetApp, etc.) provide their own modules.

PSA is conceptually similar to Linux's device-mapper + multipath stack, but more tightly integrated with the VM lifecycle (the storage layer knows about VMs as first-class objects, not just filesystems containing VM files).

### vSAN

VMware vSAN is a hyperconverged distributed storage system: each ESXi host contributes local SSDs/HDDs to a cluster-wide storage pool. VMs see VMFS-like semantics but the storage is striped/mirrored across hosts. vSAN is the storage equivalent of "many compute nodes form one cluster"; it competes with Ceph and similar distributed storage.

## Networking: vSwitches and the virtual network

Each ESXi host has one or more **virtual switches** that connect VM virtual NICs to physical NICs.

| Switch type | Description |
|---|---|
| **vSwitch** (standard) | Per-host vSwitch, configured locally. Simple, works for small deployments |
| **vDS** (distributed virtual switch) | Cluster-wide vSwitch, configured via vCenter. Maintains consistent network policy across all ESXi hosts in a cluster |
| **NSX-T** | VMware's SDN overlay; runs distributed switching and routing in software, with VXLAN/Geneve encapsulation |

The vSwitch handles VLAN tagging, port groups, QoS (traffic shaping), security policies (promiscuous mode, MAC change, forged transmits). The vDS adds: cross-host port mirroring, NetFlow, PVLANs, LACP teaming, distributed firewall policies.

### Network virtualization features

- **VMXNET3** is the paravirt NIC driver shipped with VMware Tools; it gives much higher throughput than emulated NICs (E1000, E1000E) for cooperating guests.
- **DirectPath I/O** (passthrough): a physical NIC is assigned directly to one VM, bypassing the vSwitch. The VM has near-native network performance but the NIC can't be shared.
- **SR-IOV**: a single physical NIC presents multiple "virtual functions" that can each be assigned to a VM. Combines DirectPath performance with sharing.

The network stack is structurally similar to KVM's options (virtio-net + bridge or vhost-net or VFIO), but more deeply integrated with the vSphere management plane.

## VMware Tools — the in-guest agent

VMware Tools is the guest-side software package, installed inside guest OSes for paravirt acceleration and host integration. Roughly analogous to:
- `virtio` drivers (Linux/KVM)
- Guest Additions ([VirtualBox](/virtualization/systems/virtualbox/))
- VirtIO drivers (Windows on KVM)

What it provides:

| Component | Function |
|---|---|
| **VMXNET3 driver** | Paravirt NIC for high throughput |
| **PVSCSI driver** | Paravirt SCSI controller for high IOPS |
| **balloon driver (`vmmemctl`)** | Cooperative memory reclaim (see memory overcommit section) |
| **Time synchronization** | Keeps guest clock in sync with host (essential after snapshot resume) |
| **Heartbeat** | Lets the host detect guest hangs and trigger HA action |
| **VMware tools service** | Background daemon for guest customization, file copy, etc. |
| **Display driver** | Resolution change, multi-monitor support (for Workstation/Fusion mostly) |

Tools is open-source as `open-vm-tools`; most Linux distributions ship it pre-installed. Windows Tools is proprietary but freely available.

## Snapshots, cloning, and templates

VMware's snapshot model is one of the most refined in the industry:

- **Snapshots**: tree-structured (like VirtualBox; see [VirtualBox](/virtualization/systems/virtualbox/)'s snapshot discussion). A running VM can have a snapshot taken; the disk is forked via a delta file. Memory is optionally included.
- **Linked clones**: a clone shares its parent's disk via a delta; only differences are stored separately. Fast to create, low storage overhead.
- **Full clones**: an independent copy of the VM.
- **Templates**: a VM marked as a template; can't be powered on, used as a clone source.

The snapshot/clone semantics are deeply integrated with VMFS — operations are atomic at the VMFS level and offloaded to the array via VAAI when possible.

This is one of the features that's hardest to replicate in open-source alternatives. KVM with qcow2 supports snapshots, but the integration with management is much less seamless than vSphere's; OVS-based clouds typically don't expose snapshots through the same UI as VM management. VMware's UX advantage here is real and accounts for some of why vSphere remains the dominant enterprise virtualization stack despite open-source competition.

## vMotion: live migration

vMotion is VMware's live migration: a running VM moves from one ESXi host to another without downtime. The pre-copy mechanism:

1. Memory pages are copied from source to destination over the network while the VM continues running on source.
2. Pages that get dirtied during copy are re-sent (the "iteration phase").
3. When the dirty rate becomes low enough, the VM is paused, the residual dirty pages are sent, plus the vCPU state and device state, and the VM is resumed on the destination.

Total guest pause time is typically tens of milliseconds (achievable in practice).

VMware shipped vMotion in 2003, several years before live migration was practical in open-source competitors (Xen's pre-copy migration paper is Clark et al. 2005). The mechanism was widely copied; KVM, Xen, and Hyper-V all have analogous implementations now.

Beyond the basic vMotion:
- **Storage vMotion**: the VM's disk files migrate to different storage without downtime.
- **Cross-vCenter vMotion**: between datacenters.
- **EVC** (Enhanced vMotion Compatibility): masks CPU feature differences so VMs can migrate across heterogeneous CPU generations.

The live-migration cost-shape (network bandwidth proportional to memory + dirty rate; pause time at the end) is well-understood and shared across vMotion, KVM's pre-copy migration, and Xen's migration.

## Management: vSphere and vCenter

ESXi is the *hypervisor*. The management plane is **vSphere** (the client-side product) backed by **vCenter Server** (the server-side daemon coordinating multiple ESXi hosts).

A typical vSphere deployment:

```
vCenter Server (per cluster, ~hundreds of ESXi hosts)
   │  central management, policy, vMotion orchestration, DRS, HA
   ▼
vSphere Client / API
   │  user-facing UI, REST API, PowerCLI
   ▼
multiple ESXi hosts
   │  each runs hostd (the host's management agent)
   │  vCenter talks to hostd via vpxa (vCenter Agent)
   ▼
on each host: VMkernel + many VMs
```

vCenter adds capabilities ESXi alone doesn't have:
- **DRS** (Distributed Resource Scheduler): automatic vMotion based on load to balance compute across the cluster.
- **HA** (High Availability): if a host fails, restart its VMs on other hosts automatically.
- **DPM** (Distributed Power Management): power off underutilized hosts to save power.
- **Storage DRS**: automatic storage vMotion to balance storage utilization.
- **Cluster-wide policies, RBAC, templates, snapshot management.**
- **Integration with NSX, vSAN, vRealize Suite.**

vCenter Server itself is a substantial product — its own Linux-based appliance, PostgreSQL database, web server, several Java services. It's effectively a small cluster-orchestration system, predating Kubernetes by years and aimed at a similar problem (managing many compute nodes).

The relationship to ESXi: ESXi is the hypervisor that can run standalone; vCenter is the management that makes ESXi practical for production deployments. ESXi without vCenter is uncommon in enterprise use.

## ESXi vs other Type-1 hypervisors

The survey now has four Type-1 hypervisor notes. Comparing structurally:

| System | §03 shape | Privileged surface | Driver model |
|---|---|---|---|
| **Xen** | Disaggregated | Hypervisor + dom0 (Linux) | dom0 hosts most drivers |
| **hvisor** | Separation kernel | Hypervisor + zone0 (Linux) | zone0 hosts drivers; virtio-trampoline |
| **AxVisor** | Unikernel-application | ArceOS unikernel + visor application | ArceOS provides drivers |
| **VMware ESXi** | Monolithic | VMkernel only | VMkernel has all drivers |

ESXi's monolithic design has the largest privileged surface — every device driver runs in VMkernel context. This is the trade-off: simpler architecture, faster device I/O (no domain crossing), but a bug in any driver is a hypervisor bug. Xen's disaggregated design pushes drivers into dom0 to isolate them from the hypervisor; ESXi accepts the bigger TCB in exchange for performance and operational simplicity.

There's no open-source equivalent of ESXi's exact architectural shape. KVM-based stacks (QEMU+KVM, Firecracker, Kata) are all Type-2-ish (using Linux as the substrate). Xen and hvisor are disaggregated. ESXi is the production monolithic Type-1, and it's only available as a commercial product.

## Performance

ESXi is competitive with the best open-source hypervisors on most workloads:

| Workload | Bare metal | ESXi (with EPT + VMware Tools) |
|---|---|---|
| CPU-bound | 1.0× | ~0.95-0.98× |
| Memory-bound | 1.0× | ~0.95-0.97× |
| Storage (VMFS to SAN) | 1.0× | ~0.85-0.95× |
| Storage (DirectPath / SR-IOV) | 1.0× | ~0.98× |
| Network (VMXNET3 + vSwitch) | 1.0× | ~0.85-0.95× |
| Network (SR-IOV / DirectPath) | 1.0× | ~0.97× |

Where ESXi excels relative to other hypervisors:
- **SMP-heavy workloads** because of co-scheduling.
- **Storage workloads** because of VMFS + VAAI offload.
- **Mixed workloads with overcommit** because of the memory overcommit hierarchy.

Where ESXi lags or matches:
- **Single-VM micro-benchmarks** are typically a tie with KVM+vhost (within a few percent).
- **High-PPS networking** without DirectPath is comparable to KVM; vSwitch overhead is real.

The overall observation: ESXi is highly tuned for the *mixed datacenter workload* of "many VMs of various sizes and characteristics on shared hardware". Single-VM hot-path metrics aren't its target; aggregate-throughput-with-fairness is.

## Where ESXi sits in the design space

Updated comparison table including ESXi alongside the other systems studied:

| System | Isolation | TCB | Hosts | Code size | Workload class |
|---|---|---|---|---|---|
| **VMware ESXi** | **Hardware (VT-x + EPT)** | **VMkernel (~2-5 MLoC C, closed source)** | **Bare metal only** | **Large** | **Enterprise datacenter virtualization** |
| Xen (Type-1, disaggregated) | Hardware (VT-x + EPT) | Hypervisor + dom0 kernel | Bare metal | Medium (hypervisor ~250 KLoC) | Cloud, server (open-source) |
| QEMU+KVM | Hardware (VT-x + EPT) | Linux + KVM + QEMU (~1.5 MLoC C) | Linux only | Large | Universal: cloud, dev, embedded |
| Firecracker | Hardware (VT-x + EPT) + Rust + jailer | Linux + KVM + Firecracker (~50 KLoC Rust) | Linux only | Tiny | Cloud serverless / microVM |
| VirtualBox | Hardware (VT-x + EPT) + own kernel module | Host kernel + vboxdrv + VBoxVMM (~1.5 MLoC C++) | macOS/Windows/Linux/Solaris | Large | Desktop virtualization |
| Kata Containers | Hardware via underlying VMM | Guest kernel + VMM + host kernel + Kata runtime | Linux only | ~80 KLoC | Containers with VM isolation |
| gVisor | Software (userspace kernel reimpl) | Sentry + Gofer + small host kernel | Linux only | ~500 KLoC Go | Multi-tenant userspace isolation |
| Docker | Software (kernel feature flags) | Entire Linux kernel | Linux only | ~50 KLoC core + kernel | Native-perf shared-kernel containers |

ESXi's distinctive cell: the only **commercial, closed-source, bare-metal monolithic Type-1** in the comparison. Its competitive position has been threatened by KVM-based open-source stacks since the late 2000s, and especially by Kubernetes-based abstractions that hide the hypervisor layer. The Broadcom acquisition (2023) and subsequent licensing changes have accelerated migration away from VMware in some segments. But the technical product remains the gold standard for "I want to run a datacenter of mixed-workload VMs with the best operational tooling and the most refined scheduler/memory-manager".

## Architecture matrix

| Topic | VMware ESXi |
|---|---|
| **Placement** | Type-1 bare-metal monolithic |
| **Guest CPU** | VT-x / AMD-V via vmm world; co-scheduled SMP |
| **Guest memory** | EPT / NPT; three-mechanism overcommit (TPS + balloon + swap + compress) |
| **Address space** | Standard VMX non-root with EPT |
| **Hardware support** | Required: VT-x / AMD-V + EPT/NPT; VT-d for passthrough |
| **CPU virtualization** | Hardware-only in modern versions (BT legacy) |
| **Memory virtualization** | EPT/NPT; pmap maintained by VMkernel |
| **Memory overcommit** | TPS + ballooning + memory compression + hypervisor swap |
| **Device emulation** | ~30-40 devices in vmm/vmx; VMXNET3, PVSCSI for paravirt acceleration |
| **Storage** | VMFS + PSA + vSAN; offloaded to array via VAAI |
| **Networking** | vSwitch / vDS / NSX; VMXNET3 paravirt + SR-IOV/DirectPath passthrough |
| **Filesystem** | VMFS (cluster FS for shared SAN/iSCSI); NFS as alternative |
| **Hypercall ABI** | VMware-specific paravirt interface (vmcalls for cooperating guests) |
| **Snapshots** | Tree-structured, integrated with VMFS, offload-capable |
| **Live migration** | vMotion + Storage vMotion + Cross-vCenter vMotion |
| **Control plane** | hostd (per-host), vCenter (per-cluster); REST API + PowerCLI + vSphere Client |
| **TCB** | VMkernel (~2-5 MLoC closed source) |
| **Startup time** | Boot ESXi: minutes; boot a guest: seconds |
| **Per-syscall overhead** | Zero in-guest (it's a normal VM) |
| **Steady-state CPU overhead** | 2-5% |
| **Memory overhead** | ~few GB VMkernel + per-VM overhead |

One-sentence summary: **VMware ESXi is the design that proves the §03 monolithic Type-1 hypervisor shape works at production scale, paying for it in a closed-source codebase of millions of lines and a privileged TCB the size of a moderate operating system, in exchange for the most tightly integrated and refined commercial virtualization stack in the industry.**

## Source map

VMware is closed-source. There is no public source tree to cite. The closest things to "source map" are:

- **Published papers**:
  - Disco (Stanford, 1997). The research predecessor to VMware.
  - Memory Resource Management in VMware ESX Server (Waldspurger, 2002). The canonical reference for TPS / ballooning / swap.
  - A Comparison of Software and Hardware Techniques for x86 Virtualization (Adams & Agesen, 2006). Compares software (BT) and hardware (VT-x) techniques.
- **VMware technical white papers**: vmware.com publishes extensive technical material on vSphere, ESXi, vSAN, NSX. These are marketing-flavored but technically substantial.
- **Public conference talks**: VMworld / VMware Explore presentations cover internals.
- **`open-vm-tools`**: the only fully-open-source component, on GitHub at `vmware/open-vm-tools`. Useful for understanding the guest-host paravirt interface.
- **Reverse-engineering writeups**: community efforts have documented some VMkernel internals via observation; less authoritative than official material.

## Relationship to Astervisor

VMware ESXi is the *largest* and *most closed* system in the survey. The lessons are mostly cautionary on architecture and positive on specific techniques.

| Choice | VMware ESXi | Astervisor (planned) |
|---|---|---|
| Codebase visibility | Closed-source, proprietary | Open-source (MPL-2.0) |
| Codebase size | ~2-5 MLoC C | Small, TCB-bounded |
| Architectural shape | Monolithic Type-1 | Type-1 framekernel (small TCB + language-isolated domains) |
| Driver model | All in VMkernel | OSTD provides primitives; visor isolated |
| Memory overcommit | TPS + balloon + swap + compress | TBD (likely not in initial scope) |
| Workload class | Datacenter enterprise virtualization | Cooperating Rust domains |

### Cautionary lessons

- **Monolithic TCB is expensive.** ESXi's ~2-5 MLoC VMkernel is the privileged surface; bugs anywhere in it are hypervisor-level. The trade VMware made was to accept this in exchange for performance and operational integration. Astervisor's design — small unsafe TCB in OSTD + language-isolated visor — explicitly rejects this trade. Reading ESXi shows what "the simpler, faster, less-isolated architecture" looks like as a working product: it's possible to build, but the TCB cost is real and compounds over decades of feature additions.
- **Closed source has real costs to the ecosystem.** ESXi can't be audited externally, can't be extended by users, can't be reused as a base for other systems. Each ESXi feature requires VMware to build and maintain it internally. This is the opposite of the lesson Xen, KVM, and Linux teach. Astervisor's open-source commitment is structurally correct; ESXi is the counterexample.
- **Driver compatibility is a perpetual burden.** VMware maintains a Hardware Compatibility List (HCL) of supported hardware; getting on the HCL requires VMware certification of each device driver. This is a perpetual coordination cost between VMware and hardware vendors. Astervisor depending on OSTD's hardware abstraction is the right strategy: let the framework deal with hardware, focus the visor on the isolation work.
- **Feature accretion is the dominant force in long-lived products.** ESXi has accumulated decades of features (snapshots, vMotion, DRS, HA, EVC, FT, vSAN, NSX integration, GPU support, encryption, dozens of guest types). Each feature is justified by some real customer need but the cumulative complexity is enormous. Astervisor should set explicit scope boundaries and revisit them periodically; default to refusing features outside scope.

### Positive lessons

- **Co-scheduling is a real technique worth knowing.** VMware's scheduler co-schedules SMP guests to avoid lock-holder preemption. This has had measurable performance benefits for SMP workloads. If Astervisor ever supports SMP guests, the co-scheduling lesson is directly applicable. (Currently Astervisor's "cooperating Rust domains" model doesn't have an obvious lock-holder problem because cooperation is at the language level, but if real OS-level SMP guests are ever in scope, the lesson matters.)
- **Memory overcommit is a triad, not a single technique.** ESXi's combination of TPS (content sharing) + ballooning (cooperative reclaim) + swap (uncooperative reclaim) covers the design space. The lesson generalizes: when designing a resource-overcommit mechanism, build the cooperative path *and* the uncooperative path. Cooperating guests get the better experience; non-cooperating guests still don't crash the host.
- **Tools-as-paravirt-driver is the right model for cooperation.** VMware Tools is structurally similar to virtio drivers, Guest Additions, kata-agent, GA-style packages. Astervisor's analog is "the Rust crates a cooperating domain links against to participate in the visor's protocols". The pattern is universal: cooperation is in-guest software that the user installs.
- **The management plane is part of the product.** vCenter is at least as much of "what VMware sells" as ESXi is. Astervisor will need to think about management early: how do users start, configure, monitor, and orchestrate domains? Treating the management as an afterthought is one of the things that hurt open-source hypervisor adoption (KVM has it; Xen has it; the management story is much harder to assemble than VMware's all-in-one stack). Astervisor should at least have a small management story from day one, even if the full product comes later.

## What this teaches that other notes don't

VMware ESXi is the only system in the survey that demonstrates:

1. **The §03 monolithic Type-1 shape can be a production winner.** Xen chose disaggregated and won the open-source server market; ESXi chose monolithic and won the enterprise datacenter market. Both shapes work at scale. The survey now has case studies for both, plus the separation-kernel (hvisor) and unikernel-application (AxVisor) variants — the complete §03 picture.

2. **Closed source, closed driver model, closed integration can sustain a market for ~25 years.** VMware's commercial success from 1998 to the Broadcom acquisition in 2023 was substantial — by 2020 VMware was a ~$13B revenue company on the back of ESXi + vSphere. The proprietary model works (at least for a long time, until open-source catches up enough that the integration premium isn't worth the licensing premium). The KVM-based open-source ecosystem has been competitive since ~2010 and increasingly dominant since ~2018; the Broadcom shift accelerated migration away from VMware. The lesson isn't "closed source loses" — it's "closed source wins until open source has sufficient integration".

3. **The memory overcommit techniques are foundational and universal.** Page sharing, ballooning, hypervisor swapping, and memory compression all came from VMware's late-1990s / early-2000s work. Every subsequent hypervisor has implemented some version of these. The architectural patterns are stable and worth understanding from the original source.

Together with [Xen](/virtualization/systems/xen/) (disaggregated Type-1), [hvisor](/virtualization/systems/hvisor/) (separation kernel), [AxVisor](/virtualization/systems/axvisor/) (unikernel application), this note completes the survey's coverage of the four major Type-1 hypervisor shapes. The architectural lessons travel even when the workload class differs (server vs embedded vs datacenter vs research).
