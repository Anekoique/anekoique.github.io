---
date: '2026-05-17T14:00:00+08:00'
draft: false
title: 'Virtualization Series 05 — Memory Virtualization'
slug: 'memory'
tags: ["Virtualization", "Hypervisor", "Systems", "Memory"]
series: ["Virtualization Series"]
summary: "From shadow page tables to nested paging (EPT, NPT), with the overcommit toolbox: demand allocation, ballooning, content-based page sharing, hypervisor swapping, idle-memory taxation."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

The memory model, introduced in [§03](/virtualization/vmm-architecture/), maintains the relationship between **guest-physical** and **host-physical** addresses. This section examines how that relationship is built, kept consistent as the guest manages its own page tables, and stretched when a VMM presents more memory than it has.

Three concerns dominate any memory-virtualization design: **address translation** (how a guest virtual address ends up as a host physical address), **memory protection** (how the VMM ensures one guest cannot reach another's memory), and **memory management** (how the VMM allocates, reclaims, and overcommits host memory across guests). The first two are tightly coupled to CPU virtualization — every page-table update is, in effect, a sensitive operation — and have followed the same arc from software emulation to hardware assistance. The third is largely independent and has its own substantial body of techniques.

## The Address-Translation Problem

A guest OS believes it manages two-level translation: virtual addresses (used by guest code) to physical addresses (the "machine" addresses, as the guest sees them). The VMM knows there is a third level underneath: the guest's "physical" addresses are actually *guest-physical* addresses, and the real memory the hardware accesses lives at *host-physical* addresses.

```
guest-virtual  ──guest PT──→  guest-physical  ──VMM mapping──→  host-physical
```

The hardware MMU walks page tables and produces an address. By default, it walks the guest's page tables and produces what the *guest* believes are physical addresses — but those addresses do not correspond to anything real. The VMM must arrange, somehow, that the address eventually used by hardware is a *host* physical address. There are two basic strategies: translate in software by maintaining shadow tables, or translate in hardware by adding a second translation stage.

## Shadow Page Tables

Before hardware support arrived, the VMM closed the gap with **shadow page tables**. The idea is that the hardware MMU is configured to walk a third, VMM-maintained set of page tables — the *shadow* tables — that already encode the composition (`guest-virtual → guest-physical → host-physical`). The guest's own page tables are inert from the hardware's point of view; they exist only as data the VMM consults.

Maintenance is the difficult part. Every guest update to its page tables must be reflected in the shadow tables, or the guest will run with stale translations. Two implementation strategies appear:

- **Trap on every guest page-table write.** The VMM marks guest page-table pages read-only. Any guest write traps; the VMM emulates the write, recomputes the affected shadow entries, and resumes. This is correct but slow — page-table updates are common, and each one becomes a VM-exit.
- **Lazy synchronization on TLB flush.** The VMM allows guest writes to proceed but invalidates affected shadow entries lazily; when the guest issues an `INVLPG` or `MOV CR3` (which it must, to make its updates visible), the VMM uses that as a synchronization point. Cheaper in the common case, more complex to implement correctly.

In either strategy, the VMM holds one shadow table per guest address space — and a multi-process guest creates many of them. Shadow tables together can consume a substantial fraction of the host memory the VMM has at its disposal, and the maintenance cost dominates kernel-heavy workloads.

The technique was the only option for first-generation hardware-assisted x86, and the engineering cost of getting it right (correctness under self-modifying page tables, large guests, NUMA) is one of the reasons hypervisor codebases of the era were so large.

## Nested Paging: EPT and NPT

Intel's **Extended Page Tables (EPT)** and AMD's **Nested Page Tables (NPT)** add a second hardware-walked translation layer. The first layer is the guest's own page tables, walked exactly as on bare hardware; the second is a VMM-managed table that translates guest-physical to host-physical.

```
guest-virtual ──guest PT──→ guest-physical ──EPT/NPT──→ host-physical
                  ↑                              ↑
            guest manages                  VMM manages
```

The transformative consequence: **the guest can manage its own page tables without the VMM ever intervening.** A guest write to its page tables, a `MOV CR3`, an `INVLPG` — all execute natively. The VMM is involved only when the second-stage mapping itself must change: when memory is added or removed from the guest, when overcommit policies reclaim a page, when a guest physical page is migrated to a different host page.

The cost paid is a longer page-table walk. A first-stage walk through a four-level guest page table now requires, at each step, a second-stage walk through the EPT to translate that step's guest-physical address. In the worst case, a single TLB-miss costs roughly **24 memory accesses** for 4-level paging (5 walk stages × ~4 EPT lookups per stage, plus the final guest-leaf reads), and **~36** for 5-level paging on Ice Lake and later. Hardware mitigates this with TLBs that cache the composed translation and with paging-structure caches that retain partial walks, so steady-state performance remains close to native.

The shadow vs. nested trade-off in summary:

| | Shadow Page Tables | Nested Paging (EPT / NPT) |
|---|---|---|
| Hardware support | none required | required |
| Translation walks | one (composed in shadow) | two-stage |
| Guest PT updates | every update intercepted | none intercepted |
| TLB pressure | shadow entries cached normally | TLB caches composed translation |
| Memory overhead | one shadow PT per guest address space | one second-stage PT per guest |
| Steady-state cost | high on page-table-heavy workloads | low; bounded by walk depth |
| Code complexity in VMM | high | low |

Nested paging is the dominant approach today. It is one of the most consequential single hardware additions to virtualization since VT-x itself: it eliminated an entire class of VM-exit, simplified VMM code substantially, and is a precondition for several other optimizations (live migration with fast page tracking, transparent overcommit) that build on the second-stage table.

## Memory Protection Between Guests

With nested paging, the second-stage table is also the protection mechanism. Every guest-physical access goes through the EPT/NPT walk; the VMM controls which host-physical pages are mapped, and any guest access outside its allocated set faults to the VMM. There is no separate protection mechanism — the translation table *is* the protection.

For DMA, the analogous mechanism is the **IOMMU** (Intel VT-d, AMD-Vi). DMA-capable devices issue addresses on the bus; the IOMMU translates those addresses through a separate page table the VMM controls, faulting on any access outside the guest's allocation. Without the IOMMU, a guest with direct device access could direct the device to DMA anywhere in physical memory; with it, the device is confined exactly as the guest is. IOMMUs are treated in more detail in [§06 I/O Virtualization](/virtualization/io/).

Protection in the absence of either nested paging or an IOMMU — the regime of the early 2000s — required substantially more software work and substantially more trust in the device drivers. Both extensions can be read as the hardware moving the protection mechanism out of the VMM's software path and into silicon.

## Memory Management and Overcommit

The address-translation mechanisms above answer *how* a guest's memory is mapped. They do not answer *how much* memory each guest gets, where the host memory comes from, or what happens when the host runs short. These are policy questions, and they are where most of the operational interest in memory virtualization lives.

A naive VMM allocates host memory for each guest at creation and never reclaims it. The host can then host only as many guests as fit literally in physical memory. **Overcommit** is the practice of presenting more guest memory than the host has, on the bet that not all guests will use all their memory at the same time. Several mechanisms implement overcommit, each with its own trade-offs.

### Demand allocation

The simplest overcommit mechanism: do not allocate host pages until the guest actually touches them. A guest that requests 8 GB but uses 1 GB in steady state costs 1 GB of host memory.

Demand allocation interacts cleanly with nested paging: the second-stage table starts empty for guest pages that have never been touched, and an EPT fault on first touch lets the VMM allocate a host page on demand. The mechanism is essentially the same as demand paging in a conventional OS.

### Ballooning

A guest cooperatively returning memory it isn't using is a much better signal than the VMM guessing. **Ballooning** installs a small driver in the guest that, on request from the VMM, allocates pages from within the guest and tells the VMM their guest-physical addresses. The VMM then unmaps and reclaims those host pages.

```
       guest                       VMM
   ┌────────────┐             ┌────────────┐
   │ free pages │             │            │
   │ ┌────────┐ │  inflate    │            │
   │ │balloon │ │ ──────────→ │ reclaim    │
   │ │ driver │ │             │ host pages │
   │ └────────┘ │             │            │
   └────────────┘             └────────────┘
```

The guest's own memory subsystem decides which pages to give up — typically clean cache pages, since they are cheapest to evict. From the guest's perspective, the balloon driver simply holds memory; the guest's own allocator routes around it. From the host's perspective, the corresponding host pages are freed and can be given to other guests.

Ballooning is the most-used overcommit mechanism in production. Its limitations are that it requires guest cooperation (an unmodified guest will not have a balloon driver) and that it is slow — a balloon takes seconds to inflate enough to free non-trivial amounts of memory.

### Content-based page sharing

If two guests have identical page contents — common when many guests run the same OS image — the host can keep one copy and map both guests' translations to it. **Content-based page sharing** scans memory in the background, hashes pages to find candidates, and uses copy-on-write to merge identical pages.

```
guest A ──┐
          ├──→ shared host page (read-only, COW)
guest B ──┘
```

Sharing was historically a substantial win: in a VDI deployment with 50 identical Windows VMs, a substantial fraction of memory could be shared. Two factors have eroded the gain. First, address-space layout randomization makes identical-content matches less likely. Second, side-channel attacks that exploit the timing differences between COW faults and ordinary page accesses (variants of the rowhammer / cache-attack family) have led to sharing being disabled by default on most hosts, especially in multi-tenant settings.

### Hypervisor-level swapping

When all the cooperative mechanisms above fail to free enough memory, the VMM can swap guest pages to host disk — exactly as an OS swaps process pages. This is the last-resort mechanism: it is slow, the VMM does not know which guest pages are hot (the guest's own paging decisions are invisible), and a swap-storm can collapse aggregate performance across all guests on the host.

Production hypervisors use a tiered policy: balloon first, share second, swap only as a last resort.

### Idle-memory taxation

A subtler mechanism, introduced by VMware ESX: charge guests for *active* memory at the normal rate, but charge them more for memory they are not actively using. The guest's true working set is observable to the VMM via access bits in the second-stage page tables; idle memory is the difference. Taxing idle memory creates economic pressure on guests with overlarge allocations to balloon down voluntarily, even before the host is under pressure.

### Summary

| Mechanism | Granularity | Guest cooperation | Latency | Notes |
|---|---|---|---|---|
| Demand allocation | per-page | none | microsec | the universal baseline |
| Ballooning | per-page (guest-chosen) | required (driver) | seconds | preferred reclaim mechanism |
| Page sharing | per-page (background) | none | seconds (scanning) | often disabled for security |
| Hypervisor swapping | per-page | none | millisec (disk) | last resort |
| Idle taxation | indirect | none (mechanism); required (response) | indirect (triggers ballooning) | shapes ballooning decisions |

The mechanisms compose: demand allocation and ballooning are universal; sharing is opportunistic; swapping is emergency. The policy that combines them is one of the most carefully tuned components of any production hypervisor.

## Other Concerns

A few topics are worth naming briefly, even though detailed treatment is out of scope.

- **Huge pages.** Backing guest memory with 2 MB or 1 GB host pages reduces TLB pressure substantially — a particularly large effect with nested paging, where each second-stage walk is itself shorter when the second stage uses huge pages. Most production hypervisors prefer huge pages by default.
- **NUMA.** Guest memory should be allocated on the NUMA node closest to the pCPUs running the guest's vCPUs. A VMM that allocates carelessly can leave a guest's vCPU on one node and its memory on another, paying remote-access cost on every miss. vNUMA — presenting a NUMA topology to the guest itself — is the next step, letting the guest's own allocator make NUMA-aware decisions.
- **Memory hotplug.** Adding or removing memory from a running guest, used by elastic cloud services. Implementation is straightforward when the guest cooperates (most modern OSes do); complications arise around device DMA and live migration.

## What this section established

A VMM virtualizes memory along three axes. Address translation is performed either by VMM-maintained shadow tables (legacy) or by hardware-walked nested paging (EPT / NPT, the modern default), which eliminates the need to intercept guest page-table updates and is one of the largest single performance gains in the history of x86 virtualization. Protection is provided by the second-stage table for CPU accesses and by the IOMMU for DMA. Management — the policy by which host memory is allocated to and reclaimed from guests — combines demand allocation, ballooning, content-based sharing, swapping, and idle-memory taxation, composed into a tiered policy that responds to host pressure progressively.

The next section, [I/O Virtualization](/virtualization/io/), takes up the third component of the VMM and examines how virtual devices are presented to the guest, how I/O is routed to and from real hardware, and how the design space spans full emulation, paravirtual rings (`virtio`), and direct device pass-through.
