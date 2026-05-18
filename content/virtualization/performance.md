---
date: '2026-05-17T10:00:00+08:00'
draft: false
title: 'Virtualization Series 09 — Performance and Overhead'
slug: 'performance'
tags: ["Virtualization", "Hypervisor", "Systems", "Performance"]
series: ["Virtualization Series"]
summary: "What virtualization actually costs on modern hardware. CPU, memory, I/O, scheduling, and memory-pressure overhead components, and the residual costs that two decades of hardware extensions have not eliminated."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

Earlier sections introduced the cost components of individual virtualization mechanisms — VM-exit cost in [§04](/virtualization/cpu/), page-walk cost in [§05](/virtualization/memory/), the I/O performance gap in [§06](/virtualization/io/), the boundary-crossing cost in [§07](/virtualization/communication/), the migration downtime number in [§08](/virtualization/vm-management/). This section pulls those threads together and asks the question they all bear on: *what does virtualization actually cost, in aggregate, and where does the cost come from?*

The question matters because it sets the baseline against which any alternative isolation mechanism — language-level, hardware-encrypted, or otherwise — must be measured: if traditional virtualization has driven its overhead down to a few percent on most workloads, the bar for "improvement" is not the once-substantial costs of first-generation VT-x but the close-to-native steady state of contemporary KVM. It also surfaces the *sources* of the residual overhead, which are the parts of virtualization that a different mechanism might or might not reduce.

## The Anatomy of Overhead

The overhead a virtualized workload pays relative to running on bare metal can be decomposed into a small number of components. The components are largely independent — a workload can be CPU-overhead-bound, I/O-overhead-bound, or memory-overhead-bound — and the dominant component depends on the workload, not on the VMM.

### CPU overhead

CPU overhead is the cost of running guest instructions through the virtualization layer. On modern hardware-assisted x86, the components are:

- **VM-exit cost** for sensitive operations the VMM still mediates. Hundreds to low thousands of cycles per exit, multiplied by exits per second.
- **State save/restore** on each exit/entry pair. Built into VM-exit cost above.
- **Two-stage page-walk cost** on TLB misses. Up to 4× more expensive than a single-stage walk in the worst case, mitigated by TLB caching.
- **Pipeline and microarchitectural disturbance.** Difficult to measure but real; cache pressure from VMM code, branch predictor pollution, TLB invalidation.

For workloads that touch sensitive state rarely (steady-state user-space compute), the steady-state overhead is in the low single digits of percent. For workloads that touch sensitive state often (kernel-heavy code, frequent IPC, fork/exec storms), it can reach 10–20% and occasionally more.

The historical trajectory is steeply downward. First-generation VT-x with shadow page tables imposed 10–30% overhead on MMU-intensive workloads (the range varies substantially per workload — VMware's published measurements show some workloads at near-zero shadow overhead and others above 50%); with EPT, VPID, APICv, and posted interrupts, the same workloads typically run within 2–5%. The headline result of the past decade is that *for most CPU-bound workloads, the question "is this VM or bare metal" can no longer be answered by performance.*

### Memory overhead

Memory overhead has two components:

- **Per-VM fixed cost.** Each VM requires data structures in the VMM (vCPU state, second-stage page tables, device-model state). For a general-purpose VMM, this is tens of megabytes per VM; for a microVM (Firecracker), it can be under 5 MB.
- **Translation-walk cost.** Treated above under CPU overhead; the second-stage walk uses additional memory bandwidth for page-table reads, particularly under TLB pressure.

The translation-walk cost is often the larger of the two. Workloads with poor TLB locality — large working sets, irregular access patterns, kernel-heavy code — pay it disproportionately. Backing guest memory with huge pages (2 MB or 1 GB) reduces the walk depth at both stages and is one of the most common production tunings.

### I/O overhead

I/O overhead is the most variable component and the most-discussed in deployment contexts. The variation depends almost entirely on the I/O technique chosen:

| Technique | Throughput vs. native | Latency overhead |
|---|---|---|
| Full emulation | 10–30% | 10×–100× |
| Virtio (user-space backend) | 60–80% | 2×–5× |
| Virtio + vhost (kernel backend) | 80–95% | 1.5×–3× |
| SR-IOV / pass-through | >95% | within a few percent |

These figures are typical for 10 GbE network workloads circa 2015; ranges depend significantly on packet size, NIC speed, and CPU. Modern vhost-user with DPDK can match SR-IOV on bandwidth-bound workloads, while full emulation drops below 10% on 25/40/100 GbE. Small-packet PPS measurements widen the gap further. Storage workloads show qualitatively similar patterns. The wide range is driven by exit-rate differences: full emulation incurs an exit per register access, virtio amortizes exits across many requests, vhost eliminates the user-kernel round trip, and SR-IOV eliminates the VMM from the data path entirely.

The historical trajectory in I/O has been driven by *moving the VMM out of the data path*, not by making the VMM faster. The fastest paths today (DPDK + vhost-user, SR-IOV, NVMe pass-through) are fast precisely because they don't go through the VMM at all on the steady-state path.

### Scheduling overhead

A virtualized workload competes for pCPU time with other workloads on the same host. The result is **scheduling overhead** — added latency from queueing, jitter from preemption, and the lock-holder preemption pathology described in [§04](/virtualization/cpu/). These costs do not show up in microbenchmarks of single-VM workloads but dominate the experience of latency-sensitive applications in multi-tenant environments.

Mitigations exist: CPU pinning, dedicated CPUs (Kubernetes' `cpuManagerPolicy=static`, AWS dedicated cores), no-overcommit configurations. Each trades density for predictability.

### Memory-pressure overhead

When a host is at memory pressure, the overcommit mechanisms of [§05](/virtualization/memory/) kick in: ballooning frees guest memory cooperatively (slow); page sharing reclaims duplicates (slower); swapping pages out (much slower). Workloads that hit memory pressure pay overhead that bears no relation to their own behaviour — they pay because *other guests* on the host are using memory.

This is one of the largest sources of unpredictability in cloud workloads, and the reason memory overcommit is often disabled in performance-critical deployments.

## What Drives the Residual Overhead

Hardware extensions over the past two decades have eliminated most of the *avoidable* overhead. What remains divides cleanly into a small number of categories:

- **Mediation that cannot be eliminated.** A small set of guest operations genuinely require VMM intervention (some MSR writes, some interrupt-controller operations, the configuration path of every device). These costs can be reduced (APICv, VMCS shadowing) but not removed.
- **Translation cost.** The two-stage page walk imposes a fundamental cost on TLB misses that no amount of hardware optimization eliminates entirely. Huge pages reduce the cost; they do not remove it.
- **Boundary-crossing cost on I/O.** Even with virtio + vhost, a notification still costs something, and the receiver still pays a context switch. Polling eliminates this at the cost of CPU; there is no zero-cost option.
- **Cache and TLB pollution from co-tenants.** Other guests on the same host evict your cache lines and your TLB entries. This cost is invisible in single-tenant benchmarks and often dominant in production. It is fundamentally a hardware-resource-sharing cost, not a virtualization cost — but virtualization is what enables the sharing.

The first three are the "virtualization tax" properly so called: costs that exist *because* the workload is virtualized. The fourth is a multi-tenancy cost that virtualization happens to enable.

## How Alternative Isolation Mechanisms Compare

When evaluating any alternative to hardware-isolated VMs — language-level isolation (RedLeaf, Theseus), confidential computing (SEV, TDX, CCA), or hybrid designs — the meaningful comparison is per-component: *for each piece of the residual overhead above, does the alternative do better, the same, or worse than the hardware mechanism it replaces?*

For language-level isolation, the pattern that emerges from RedLeaf-style and Singularity-style work is:

- **Mediation cost.** A language boundary does not require a VM-exit; a function call across a language-checked boundary costs effectively nothing. Operations that traditional virtualization mediates because the hardware boundary requires it become free. *Strong potential win.*
- **Translation cost.** If only cooperating language-checked guests are supported, no second-stage translation is required for compatibility — language safety bounds memory access directly. TLB-miss cost drops back to single-stage. *Strong potential win — but only for guests that opt into the model.*
- **Boundary-crossing cost on I/O.** A typed channel between guest and device backend can transfer ownership of a buffer with a function call. If the type system can prove the transfer is safe, no runtime check is needed. *Strong potential win.*
- **Cache and TLB pollution.** Unchanged. This is a hardware-sharing cost, not a virtualization cost; nothing about the isolation mechanism changes it. *Neutral.*

The expected pattern: language-level isolation can reduce or eliminate the per-event mediation costs that traditional virtualization has been chipping away at for two decades, but cannot affect the costs that come from sharing physical resources. The performance argument is therefore strongest on workloads that are mediation-heavy — kernel-heavy code, frequent cross-component IPC, fine-grained device interaction — and weakest on workloads that are dominated by raw resource use.

For confidential computing, the trade-off is inverse: encryption adds per-event cost (a fact that the SEV-SNP and TDX overhead measurements bear out) in exchange for a stronger threat model. The two mechanisms address different parts of the design space and can in principle compose.

## What this section established

Virtualization overhead, on modern hardware, decomposes into CPU, memory, I/O, scheduling, and memory-pressure components. CPU and memory overhead have been driven down to single-digit percentages on most workloads through hardware extensions; I/O overhead spans an order of magnitude depending on technique, with the fastest paths achieving near-native performance by removing the VMM from the data path; scheduling and memory-pressure overheads are environmental and mostly outside any individual VMM's control.

The residual virtualization overhead falls into a small number of categories: mediation costs that cannot be entirely eliminated, two-stage translation cost, I/O boundary-crossing cost, and cache/TLB pollution from co-tenants. These are the costs against which any alternative isolation mechanism must be measured. Three of the four are at least conceivably reducible by language-level isolation; the fourth (resource-sharing pollution) is not.

This closes the core sequence of the survey. From the [Popek–Goldberg condition](/virtualization/foundations/) onward, each section has named one part of the design space and the mechanisms by which traditional systems have populated it. Read together, the chapters describe a mature engineering discipline whose costs have been driven down to the point where the dominant pressures — TCB size, cold-start latency, density — are no longer about *making virtualization faster* but about *changing what virtualization is for*. That is the trajectory the [History](/virtualization/history/) chapter traces from the outside.
