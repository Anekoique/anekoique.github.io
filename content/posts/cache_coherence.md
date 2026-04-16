---
date: '2026-04-16T10:00:00+08:00'
draft: false
title: 'Cache Coherence'
tags: ["OS", "CPU", "Cache"]
summary: "How multi-core CPUs keep a consistent view of memory — the MESI protocol, bus snooping, cache-to-cache transfers, and the store-buffer / invalid-queue optimizations (plus the memory-ordering headaches they introduce)."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

## Memory Hierarchy

{{< img src="/images/cache_hierarchy.png" alt="cache hierarchy" size="large" >}}

{{< img src="/images/cache_hirrarchy_table.png" alt="cache hierarchy table" size="large" >}}

## Problem

Modern multi-core CPUs depend on caches to accelerate memory access and improve performance. However, when multiple cores cache the same memory address, maintaining a **consistent view of memory** across all cores and main memory (known as **cache coherence**) becomes a tricky problem.

## How CPU handle writes?

**Write-Through Caching**: A core writes to a cache line, the same update is immediately writtern to main memory.

**Write-Back Caching**: A core writes to a cache line which only made in the core's private cache. The new value is written back only when the cache line is evicted or needs to be shared.

## MESI Protocal

Every cache line have four states: M E S I.

{{< img src="/images/MESI.png" alt="MESI protocol" size="large" >}}

Exclusive(E):

The core have the data in it's private cache.

- write -> [M]
- Be written -> [I]
- Other read -> [S]

Shared(S):

One or more cores have a copy of the latest version of the data in their caches.

- Write -> [M]
- Other write -> [I]

Modified(M):

The core have the latest version of the data.

- Other write -> [I]

Invalidated(I)

Another core have the latest version of the data.

- Write -> [M]

- Read -> [S]/[I]

{{< img src="/images/MESI_state.png" alt="MESI state transitions" size="large" >}}

### How caches communicate

#### Bus snooping

**Bus snooping** is a hardware technique where each core monitors the **shared** system bus to keep an eye on what other cores are doing with memory.

1. Every time a core **reads or writes** to a memory address, that action is **broadcast** on the system bus.
2. Other cores **snoop (listen)** to the bus.
3. If another core has a copy of the requested data, it can:

- **Respond** with the most recent version (in Modified or Exclusive state).
- **Invalidate** or **update** its own cached copy if needed.
- **Trigger a state change** in its MESI cache line.

#### Cache-to-Cache Thansfer

When a core issues a memory read request, and another core already has the most recent copy of the requested data in its cache, it can respond directly → this is called a **cache-to-cache transfer**.

Instead of fetching the data from main memory, the owning core:

1. **Snoops** the request via the bus,
2. Recognizes that it holds the latest copy, and
3. Sends the data directly to the requesting core.

### Real scenorio

Bus signals

1. BusRd (Bus Read)

2. BusRdX (Read For Ownership) [I] -> [M]

3. BusUpgr (Bus Upgrade) [S] -> [M]

4. Flush (Write Back)

5. FlushOpt (Flush Optimization) C2C

### Limitations

1. **False Sharing →** MESI operates at the **cache line granularity**, not variable granularity. That means even if two threads access **different variables**, if those variables fall on the same cache line:

- MESI treats them as **shared data**.
- This causes **unnecessary invalidations**, even though no real data conflict exists.

2. **Scalability Issues →** MESI relies on **bus snooping**, where all cores must **snoop** every memory transaction:

- As the number of cores increases, the snooping traffic grows rapidly.
- More cores mean more invalidations, more broadcasts, and more bus congestion.

3. Latency on Writes → To write to a cache line that's shared, a core must broadcast a write intent, wait for other cores to invalidate their copies, then perform the write. This adds latency, especially when multiple cores frequently access the same data, or when contention is high.

4. No Built-in Support for Synchronization → MESI doesn't handle higher-level synchronization (like locks or barriers). It only ensures **data coherence**, not **program correctness**.

### Optimization

#### Protocol Opt

1. AMD MOESI (Owned state)
2. Intel MESIF (Forward state)

#### Store Buffers + Store Forwarding

Problem: write operations have to wait for a ack, which is a unnecessary stall for CPU.

Store buffers: write to store buffer and do another things, until receive response. Store buffer may lead to program order, Store forwarding can load data from store buffer directly.

Limitation：memory inconsistent  -> memory barrier

{{< img src="/images/cache-with-store-forwarding.png" alt="cache with store forwarding" size="large" >}}

#### Invalid Queue

Problem: The size of store buffer is limited, core B is busy to handle invalid ACK, core A will still blocked to wait invalid ACK.

Invalid Queue: Core B(the busy bus) will response ACK immediately and push it into invalid queue and handle it later.

Limitation：memory inconsistent

{{< img src="/images/cache-with-invalid-queue.png" alt="cache with invalid queue" size="mid" >}}

## Link

https://medium.com/codetodeploy/cache-coherence-how-the-mesi-protocol-keeps-multi-core-cpus-consistent-a572fbdff5d2

https://xiaolincoding.com/os/1_hardware/cpu_mesi.html#%E6%80%BB%E7%BB%93

https://wudaijun.com/2019/04/cache-coherence-and-memory-consistency/

https://aijishu.com/a/1060000000457160
