---
date: '2026-05-17T19:00:00+08:00'
draft: false
title: 'Virtualization Series 00 — History'
slug: 'history'
tags: ["Virtualization", "Hypervisor", "Systems"]
series: ["Virtualization Series"]
summary: "A historical preface to the survey, organized into five eras from IBM CP-40 (1964) through modern microVMs and language-isolated systems. Anchors each era in the papers that invented the techniques later chapters treat as ambient."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

A historical preface to the survey. The technical chapters that follow ([§01–§09](/virtualization/foundations/)) treat virtualization as a coherent design space; this chapter explains how it became that way. The shape of the design space today — Type-1 vs Type-2 placement, paravirt vs full virt, the existence of VT-x and EPT, the dominance of virtio for I/O, the recent appearance of microVMs — is the cumulative result of about sixty years of engineering, and several of the choices that look arbitrary in cross-section ("why does x86 need binary translation? why is virtio shaped like a ring? why does live migration work at all?") have clear historical answers.

The timeline below is divided into five eras. Each era is anchored to a small number of papers that capture the *invention* of the techniques the later chapters treat as ambient. Where a paper directly underpins a survey chapter, the chapter cross-reference is given.

## Era I — IBM and the invention of the VMM (1964–1979)

Virtualization was invented for *mainframe time-sharing*, not for server consolidation. The 1960s context: an IBM System/360 mainframe cost on the order of a million dollars and was rented in time-slices to dozens of users; each user wanted the illusion of a private machine running their own operating system. The IBM Cambridge Scientific Center built **CP-40** (1964–1967) to provide that illusion: a control program that ran multiple instances of a single-user OS (CMS) on the underlying hardware, each in its own *virtual machine*. CP-40 became **CP-67** for the System/360 Model 67, and in 1972 IBM released the production version, **VM/370**, for the System/370 line.

VM/370 is the system every subsequent VMM is, in some sense, retracing. Its mechanisms — privilege deprivileging of the guest, trap-and-emulate of sensitive instructions, per-VM virtual memory, virtual device emulation, a hosted CMS-style management VM — all reappear under different names in Xen `dom0`, KVM+QEMU, and hvisor's `zone0`. The vocabulary "guest OS", "virtual machine", "hypervisor" all date from this era.

The decade closed with the **Popek–Goldberg paper** (1974), which formalized what VM/370 had achieved into testable criteria. The paper defined the three classical requirements (equivalence, resource control, efficiency) and the famous *virtualizability condition*: an architecture supports an efficient VMM iff every sensitive instruction is also privileged (every operation that could break the abstraction traps when the guest tries it). The paper is the foundation §01 builds on; the condition is what §04 spends most of its space explaining how various architectures do, do not, or eventually do satisfy.

**Papers:** [*Formal Requirements for Virtualizable Third Generation Architectures*](https://dl.acm.org/doi/10.1145/361011.361073), Popek & Goldberg, CACM 1974. Treated in [§01](/virtualization/foundations/).

| Year | Event |
|---|---|
| 1964 | IBM CP-40 begins at Cambridge Scientific Center |
| 1967 | CP-67/CMS for System/360 Model 67 |
| 1972 | VM/370 released for System/370 |
| 1974 | Popek & Goldberg publish the virtualizability criteria |

## Era II — The dark age and the academic revival (1980–2000)

The minicomputer and microcomputer era took virtualization off the table. The economics that drove VM/370 — one expensive machine multiplexed across many users — disappeared as workstations and PCs put a dedicated CPU on every desk. Mainstream OS research moved to microkernels (Mach, L4), language-based systems (Smalltalk, Lisp Machines, later Spin and Singularity), and distributed systems. Virtualization persisted on IBM mainframes but became a backwater in academic systems.

The technical reason this matters: **x86 was designed during this dark age, and was designed without virtualization in mind**. The 16-bit 8086 had no concept of privileged operation; protected mode arrived in the 80286 (1982) and 80386 (1985) with four privilege rings, but the architects did not check Popek–Goldberg. A small number of instructions — most famously `POPF`, which silently fails to update the interrupt-enable flag at unprivileged level instead of trapping — violate the condition. The x86 virtualization gap, which the survey treats as a recurring problem in §04, is a consequence of this oversight.

The revival came at the end of the 1990s in three almost-simultaneous projects:

**[Disco](https://dl.acm.org/doi/10.1145/269005.266672)** (Stanford, SOSP 1997) is the academic restart. Bugnion, Devine, and Rosenblum built a VMM on the FLASH ccNUMA multiprocessor that ran multiple IRIX instances as VMs, with the explicit motivation of "running commodity OSes on novel hardware without porting the OS". The paper's opening line is "Our approach brings back an idea popular in the 1970s, virtual machine monitors." Disco demonstrated demand paging across VMs, content-based page sharing, and transparent NUMA-aware page placement — all techniques §05 still treats. Two of the three Disco authors then founded **VMware** in 1998 and turned the academic prototype into a commercial product.

**VMware Workstation 1.0** (1999) and **ESX Server** (2001) had to solve a problem Disco didn't: x86 isn't virtualizable in the Popek–Goldberg sense. The VMware engineers invented **dynamic binary translation** for x86 VMMs (§04 covers the technique) — scan the guest's instruction stream, emit a translated copy with sensitive instructions replaced by emulation calls, run from the cache. This was the first commercially deployed VMM on x86 and the first proof that the virtualization gap could be closed in software.

**[Denali](https://www.usenix.org/conference/osdi-02/scale-and-performance-denali-isolation-kernel)** (Washington, OSDI 2002) and **[Xen](https://dl.acm.org/doi/10.1145/944220.944235)** (Cambridge, SOSP 2003) took the opposite approach — close the gap by *modifying the guest*. Denali argued for "lightweight isolation kernels" running thousands of small specialized OSes (an early unikernel vision); Xen argued for *paravirtualization* of a few full-featured guest OSes. Xen won the architectural argument: its 2003 paper introduced the vocabulary (`dom0`, `domU`, hypercalls, event channels, I/O rings, grant tables, split drivers) that §03 and §07 still use. The 2003 paper is short, dense, and the single best introduction to a classical Type-1 hypervisor.

**Papers:** [Disco](https://dl.acm.org/doi/10.1145/269005.266672) (SOSP 1997); [Xen](https://dl.acm.org/doi/10.1145/944220.944235) (SOSP 2003); [Denali](https://www.usenix.org/conference/osdi-02/scale-and-performance-denali-isolation-kernel) (OSDI 2002). Treated in [§02](/virtualization/taxonomy/), [§03](/virtualization/vmm-architecture/), [§04](/virtualization/cpu/).

| Year | Event |
|---|---|
| 1985 | 80386 introduces protected mode, without virtualization support |
| 1997 | Disco demonstrates x86-style commodity-OS multiplexing on FLASH |
| 1998 | VMware founded by Bugnion, Devine, Rosenblum |
| 1999 | VMware Workstation 1.0 — first commercial x86 VMM, software-only |
| 2001 | VMware ESX Server 1.0 — first bare-metal x86 hypervisor |
| 2002 | Denali (Washington) and Waldspurger's ESX memory paper (OSDI) |
| 2003 | Xen SOSP paper; XenoLinux runs on x86 with no hardware help |

## Era III — Hardware closes the gap (2005–2010)

The most consequential change in the history of virtualization happened in silicon. In November 2005 Intel shipped the first **VT-x**-capable processor (Pentium 4 662/672); in May 2006 AMD shipped the first **AMD-V**-capable processor (Athlon 64 Orleans-rev F). Both extensions add a new operating mode (VMX root mode / SVM host mode) in which the VMM executes, and arrange for sensitive operations by the guest in non-root mode to cause a *VM-exit* into the VMM. The Popek–Goldberg condition was, for the first time, satisfiable on x86 by hardware fiat. §04's "Hardware-Assisted Virtualization" subsection covers the mechanism.

The first generation was slow. Adams & Agesen's **2006 ASPLOS paper** [*A Comparison of Software and Hardware Techniques for x86 Virtualization*](https://dl.acm.org/doi/10.1145/1168857.1168860) showed the counterintuitive result that VMware's software VMM with binary translation *outperformed* first-generation VT-x on many workloads, because the hardware mechanism still required a VM-exit per page-table update (no nested paging) and the per-exit cost was high. The paper is worth reading even today as the rare honest comparison between software and hardware virtualization techniques.

The fix came in two generations:

**Nested paging — Intel EPT (2008, Nehalem) and AMD NPT (2007, Barcelona).** Hardware-walked second-stage translation: guest manages its own page tables natively, the hypervisor manages a separate guest-physical-to-host-physical table that the MMU walks transparently. Eliminated the entire shadow-page-table mechanism and the VM-exits it required. §05's nested-paging subsection covers this in depth; the §09 overhead analysis treats it as the single largest performance gain in the history of x86 virtualization.

**KVM merging into Linux (kernel 2.6.20, February 2007).** Qumranet's **[KVM](https://www.kernel.org/doc/ols/2007/ols2007v1-pages-225-230.pdf)** (OLS 2007) demonstrated that the new hardware support made VMMs *simple*: KVM is a Linux kernel module (`/dev/kvm`) plus a per-VM user-space process (originally a forked QEMU), turning a VM into "a Linux process that happens to execute in guest mode". The architecture was so much simpler than Xen's that KVM rapidly displaced Xen as the default Linux hypervisor — by 2010 essentially every Linux distribution shipped KVM-as-default, and Red Hat acquired Qumranet in 2008.

The third leg of this era is **virtio**. Russell's [2008 paper introducing virtio](https://dl.acm.org/doi/10.1145/1400097.1400108) observed that the Linux kernel by then contained eight different paravirtual device driver stacks for eight different hypervisors (Xen, KVM, VMware VMI, IBM System p, IBM System z, UML, lguest, ...) and proposed a unified ABI: a `virtqueue` transport (a producer-consumer ring, lineally descended from Xen's I/O ring) and a small set of standardized device classes (`virtio-net`, `virtio-blk`, ...). The proposal succeeded completely; by 2014 OASIS standardized it as VIRTIO v1.0, and today every modern hypervisor — KVM, Xen, Hyper-V, ESXi, Firecracker, hvisor — speaks virtio. §06's "Paravirtual I/O" section is essentially the virtio story.

The era also produced the canonical implementations of two operational mechanisms:

- **Live migration** — Clark et al.'s 2005 NSDI paper [*Live Migration of Virtual Machines*](https://www.usenix.org/conference/nsdi-05/live-migration-virtual-machines) presented the iterative pre-copy algorithm in Xen with sub-second downtime. The mechanism §08 describes is essentially this paper, now used in every cloud hypervisor.
- **High-availability replication** — Cully et al.'s 2008 NSDI paper [*Remus: High Availability via Asynchronous Virtual Machine Replication*](https://www.usenix.org/conference/nsdi-08/remus-high-availability-asynchronous-virtual-machine-replication) extended the dirty-page tracking machinery into continuous checkpointing for fault tolerance. Less widely deployed but architecturally significant.
- **Memory overcommit at scale** — Waldspurger's 2002 OSDI paper on [ESX memory management](https://www.usenix.org/conference/osdi-02/memory-resource-management-vmware-esx-server) introduced *ballooning*, *content-based page sharing*, and *idle-memory taxation* as a coherent toolbox. §05's overcommit subsection is largely Waldspurger's vocabulary.

**Papers:** Adams & Agesen ASPLOS 2006; KVM OLS 2007; virtio EuroSys 2008; Clark live-migration NSDI 2005; Cully Remus NSDI 2008; Waldspurger ESX memory OSDI 2002. Treated in [§04](/virtualization/cpu/), [§05](/virtualization/memory/), [§06](/virtualization/io/), [§08](/virtualization/vm-management/), [§09](/virtualization/performance/).

| Year | Event |
|---|---|
| 2005 | Intel VT-x ships (Pentium 4 662/672, November); Clark live-migration NSDI |
| 2006 | AMD-V ships (Athlon 64, May); Adams & Agesen software-vs-hardware paper |
| 2007 | KVM merged into Linux kernel 2.6.20 (February); AMD NPT in Barcelona |
| 2008 | Intel EPT in Nehalem; Russell virtio paper; Cully Remus paper; Red Hat acquires Qumranet |
| 2009–10 | KVM displaces Xen as default Linux hypervisor; virtio adopted across stacks |

## Era IV — The cloud era (2010–2017)

By 2010 the technical groundwork was complete: hardware-assisted VMMs were fast, nested paging eliminated MMU overhead, virtio standardized paravirt I/O, live migration enabled operational fluidity. **The business pivot was the cloud.** Amazon EC2 (launched August 2006 on Xen), Google Compute Engine (2012, on KVM), and Microsoft Azure (2010, on Hyper-V) scaled virtualization from "tens of VMs per host" to "millions of VMs across a fleet". The technical work of this era was largely about making the existing mechanisms work at cloud scale.

Three mechanism families saw substantial work:

**I/O virtualization extensions.** Per-event mediation was the residual bottleneck in I/O performance. The cloud era added:

- **SR-IOV** (PCI-SIG standard, 2007; broadly deployed in cloud NICs by 2012). A single physical device exposes many *virtual functions* that can each be passed through to a guest with no VMM mediation on the data path. §06's "Direct Device Assignment and SR-IOV" subsection covers this.
- **IOMMU** (Intel VT-d 2008, AMD-Vi 2007). Hardware DMA confinement, making safe device passthrough possible. §05's "Memory Protection Between Guests" and §06 both depend on this.
- **APICv and posted interrupts** (Intel Ivy Bridge-EP 2013, VT-d posted interrupts Broadwell-EP 2016). Eliminated VM-exits for interrupt delivery, the last per-event mediation cost on the I/O completion path. §06 and §09 treat this.
- **vhost / vhost-user / DPDK** (Linux 2.6.34 in 2010 for vhost-net; DPDK 1.0 in 2013). Moved virtio backends out of QEMU user-space first into the host kernel and then into dedicated polling user-space processes, removing the VMM from the steady-state data path.

**Confidential computing.** A new threat model emerged from cloud economics: the *cloud provider's hypervisor* might be untrusted by the tenant. The response was hardware support for memory and CPU-state encryption inside guests, so a compromised hypervisor cannot read tenant data:

- AMD **SEV** (2016, Naples), **SEV-ES** (2017), **SEV-SNP** (2020) — encrypted VMs.
- Intel **TDX** (2021, Sapphire Rapids) — Trust Domain Extensions, conceptually similar to SEV-SNP.
- ARM **CCA** (Confidential Compute Architecture, 2021 spec).

§02's "Isolation Boundary" subsection treats confidential computing as orthogonal-but-complementary to language-level isolation: both reduce the effective TCB, by different mechanisms and against different threats.

**The Type-1 / Type-2 distinction blurred.** KVM is "Type-2 because it depends on Linux", but it runs guests in VMX non-root mode exactly the way a Type-1 would; Xen is "Type-1" but `dom0` runs a full Linux that is effectively trusted. The classical placement axis (§02) lost most of its predictive power for performance or TCB size during this era. What replaced it as the meaningful distinction was the *internal shape* of the VMM — monolithic vs hosted vs disaggregated, §03's three shapes — and the *interface* it exposes to guests.

**Papers:** The cloud era is documented less in academic papers than in vendor whitepapers and open-source code; the survey treats it through the §03–§09 chapters rather than through a single representative paper.

| Year | Event |
|---|---|
| 2006 | AWS EC2 launches on Xen |
| 2007 | SR-IOV standardized; AMD-Vi (IOMMU) ships |
| 2008 | Intel VT-d (IOMMU) and EPT ship |
| 2010 | vhost-net merges into Linux 2.6.34; Azure launches on Hyper-V |
| 2012 | Google Compute Engine launches on KVM |
| 2013 | DPDK 1.0; Intel APICv (Ivy Bridge-EP) |
| 2014 | OASIS standardizes virtio v1.0 |
| 2016 | AMD SEV; VT-d posted interrupts (Broadwell-EP) |

## Era V — MicroVMs and language-isolated systems (2018–present)

By the late 2010s the classical virtualization stack was a mature, performant, and *heavy* artifact. QEMU was over a million lines of C; KVM-on-Linux had a large kernel TCB; cold-start of a typical Linux guest took seconds. New workload classes — **serverless** (AWS Lambda, Google Cloud Run, Azure Functions) and **container alternatives** (gVisor, Kata Containers) — demanded different points on the design space: cold-start in tens of milliseconds, per-VM memory footprint under 5 MiB, density of thousands of VMs per host.

**[Firecracker](https://www.usenix.org/conference/nsdi20/presentation/agache)** (AWS, NSDI 2020) is the canonical microVM. ~50,000 lines of Rust (vs ~1.4M LoC C in QEMU), virtio-only device set, no BIOS, no PCI, direct kernel boot, KVM-hosted. Used in production for AWS Lambda and Fargate from 2018. The design philosophy — strip every mechanism that exists only to support hostile or unknown guests, since serverless guests are well-defined and cooperating — is the defining microVM idea.

Related systems in the same design space:

- **Cloud Hypervisor** (Intel et al., 2018) — Rust microVM, similar shape to Firecracker, broader device support.
- **crosvm** (Google, 2017) — Rust VMM originally for Chrome OS, now the basis for Android virtualization and parts of GCE.
- **Kata Containers** (2017) — runs container images inside lightweight VMs (originally Clear Containers + runV merger); uses Firecracker, Cloud Hypervisor, or QEMU underneath.
- **[LightVM](https://dl.acm.org/doi/10.1145/3132747.3132763)** (Manco et al., SOSP 2017) — academic precursor; showed sub-10ms VM boot using unikernel guests on a modified Xen.

In parallel, the **language-isolation thread** that [Singularity](https://dl.acm.org/doi/10.1145/1243418.1243424) (SIGOPS OSR 2007) opened in the 2000s has resumed, this time in Rust:

- **[RedLeaf](https://www.usenix.org/conference/osdi20/presentation/narayanan-vikram)** (Mars Research, OSDI 2020) — Rust OS using language-checked domains as the isolation primitive instead of hardware page tables.
- **[Theseus](https://www.usenix.org/conference/osdi20/presentation/boos)** (Boos et al., OSDI 2020) — Rust OS with extreme component decomposition under the type system.
- **[Tock](https://dl.acm.org/doi/10.1145/3132747.3132786)** (UCSD, SOSP 2017) — embedded Rust OS with language-isolated capsules.
- **[Asterinas](https://arxiv.org/abs/2506.03876)** (2024 preprint) — Rust framekernel OS with Linux ABI compatibility and a small unsafe TCB.

Rust hypervisors specifically:

- **RVM1.5** (rCore, 2020) — Rust port of a VMX-based hypervisor; influenced hvisor.
- **hvisor** (Syswonder, 2024–) — Rust separation-kernel hypervisor on aarch64/riscv64/loongarch64/x86_64.
- **axvisor** (ArceOS-hypervisor, 2024–) — Rust hypervisor built on the ArceOS unikernel framework.

The defining shift in this era: **the dominant cost in classical virtualization is no longer raw CPU/memory overhead** (which hardware extensions have driven to single-digit percent on most workloads, per §09) **but rather TCB size, cold-start latency, and density per host**. MicroVMs address the latter three by removing mechanisms; language-isolated systems address them by replacing the *enforcement mechanism* of isolation rather than removing it.

**Papers:** Firecracker NSDI 2020; LightVM SOSP 2017; RedLeaf OSDI 2020; Theseus OSDI 2020; Tock SOSP 2017; Singularity SIGOPS OSR 2007; Asterinas 2024. Treated in [§02](/virtualization/taxonomy/) (isolation boundary axis) and [§08](/virtualization/vm-management/) (microVMs).

| Year | Event |
|---|---|
| 2007 | Singularity SOSP paper revives language-level OS isolation |
| 2017 | LightVM SOSP; Tock SOSP; Kata Containers; crosvm |
| 2018 | Firecracker deployed for AWS Lambda; Cloud Hypervisor; AMD SEV-SNP announced |
| 2020 | Firecracker NSDI paper; RedLeaf OSDI; Theseus OSDI |
| 2021 | Intel TDX; ARM CCA spec |
| 2024 | Asterinas paper; hvisor / axvisor |

## The shape of the story

Five eras, three recurring themes:

**Hardware support arrives every twenty years.** IBM's System/370 SIE instruction (1980), Intel VT-x and AMD-V (2005–2006), and the confidential-computing extensions (2016–2021) each represent a hardware response to a software bottleneck that had accumulated for a decade. Software systems do not stand still in the interval; they invent workarounds (binary translation, paravirtualization) that often outperform the first generation of hardware support. The lesson §04 makes explicit: hardware extensions are not improvements *over* software techniques in some absolute sense — they are *substitutions* that shift complexity from software into silicon, with different cost profiles.

**Cooperating-guest designs keep returning.** Paravirtualization in Xen (2003), virtio paravirtual I/O (2008) as an *interface* even on full-virt guests, microVMs (2018) accepting Linux as a known-good guest, language-isolated guests (RedLeaf, 2020–) — each generation rediscovers that *some* cooperation from the guest collapses cost dramatically. Pure full virtualization remains universal as a fallback but is rarely the fast path in production.

**TCB pressure has replaced performance pressure.** In Era II–III the dominant concern was making virtualization *fast* — closing the per-event overhead. In Era IV–V the per-event overhead is small enough that the dominant concerns are TCB size (confidential computing), cold-start latency (microVMs), and density (microVMs again). Language-level isolation sits squarely in the modern phase of this trajectory.

The technical chapters that follow take this as ambient context. [§01 Foundations](/virtualization/foundations/) starts from the Popek–Goldberg condition (Era I) and works forward.
