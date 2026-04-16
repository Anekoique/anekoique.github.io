---
date: '2026-04-16T10:05:00+08:00'
draft: false
title: 'Memory Consistency'
tags: ["OS", "CPU", "Memory"]
summary: "Memory consistency models define which reorderings are legal. A walk through SC, TSO (x86), PSO, and relaxed models (ARM / POWER), plus the memory barriers used to enforce ordering when it matters."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

## Background

Hardware architectures introduce thread interleaving and memory reordering (due to store buffers and speculative execution), resulting in violations of sequential consistency.

Cache coherence guarantees that updates to a single memory address are propagated to all cores (write serialization), but it does not dictate the order of operations involving multiple addresses. Therefore, a memory consistency model is required to define global ordering rules.

## Memory consistency model

{{< img src="/images/memory-model.png" alt="memory consistency model" size="large" >}}

Memory consistency models exist at two levels:

1. the Hardware Model(CPU).
2. the Language Memory Model(Compiler).

Memory consistency models are defined by which of the four memory ordering pairs (Store-Load, Store-Store, Load-Load, Load-Store) .A specific Memory Consistency Model acts as a rulebook, specifying exactly which of these four reordering types are permissible.

A Memory Consistency Model is a contract, not a **solution** to memory consistency problem. Rather, it defines the legal boundaries of 'cheating.' It tells the programmer exactly which hardware optimizations (like Store Buffers) are active and which reordering behaviors they must expect, leaving the problem to upper layer.

### SC model

Sequential Consistency (SC) is the strongest memory model. It guarantees that the execution result is the same as if all operations were executed in some sequential order, and the operations of each individual processor appear in this sequence in the order specified by its program.

- Key Characteristic: No reordering is allowed. (Load-Load, Store-Store, Load-Store, Store-Load are all strictly preserved).
- Mental Model: Imagine a single global switch that randomly selects one core at a time to execute its next instruction.

### TSO model

Total Store Order (TSO) is a memory model used by x86. It retains strong ordering guarantees like SC but introduces a write buffer (Store Buffer) to hide write latency.

- The Major Difference: TSO allows Store-Load reordering.
- Mechanism: When a core performs a Store, the value goes into a private FIFO Store Buffer instead of memory immediately. The core then continues to execute subsequent Loads.

Problem：

```c
// Initial: X = 0, Y = 0

// Core A
X = 1;      // Store X
r1 = Y;     // Load Y

// Core B
Y = 1;      // Store Y
r2 = X;     // Load X
```

### PSO model

Partial Store Order (PSO) is slightly weaker than TSO. In addition to allowing Store-Load reordering, PSO also allows Store-Store reordering, provided the stores are to different memory addresses.

Opt:

如果 CPU 连续写了两个变量，刚好都在同一个 Cache Line 里，PSO 允许 CPU 把它们一次性发出，或者调整顺序以匹配 DRAM 的物理行，从而极大地提升内存写入速度。

Problem:

```c
// Initial: Data = 0, Flag = 0

// Core 1 (Producer)
Data = 42;  // Store 1
Flag = 1;   // Store 2

// Core 2 (Consumer)
while (Flag == 0); // Load Flag
print(Data);       // Load Data
```

### Relaxed model

Relaxed Memory Models (such as those used in ARM and IBM POWER architectures) allow the reordering of almost all memory operation pairs (Load-Load, Load-Store, Store-Load, Store-Store), preserving order only when data dependencies exist.Even in Relaxed models, hardware **never** reorders operations that have data dependencies.

{{< img src="/images/lang-memory-model.png" alt="language memory model" size="large" >}}

## Memory barriers

Since hardware models introduce reordering, architectures provide explicit instructions called **Memory Barriers (or Fences)** to force ordering when necessary.

```c
// Core A
X = 1;      // Store (Pushed to Store Buffer)

MFENCE();   // <--- The Barrier
// 1. Blocks the CPU pipeline.
// 2. Forces the Store Buffer to drain completely to cache/RAM.
// 3. Only after the buffer is empty does execution proceed.

r1 = Y;     // Load (Now guaranteed to see the latest state of memory)
```

Different hardware models require different types of barriers to balance performance and safety.

1. Full Fence (e.g., MFENCE on x86, DMB on ARM). Prevents all reordering (Store-Load, Store-Store, Load-Load, Load-Store).
2. Store Fence (Write Barrier) (e.g., SFENCE on x86). Prevents Store-Store reordering.Cost: Cheaper than a full fence.
3. Load Fence (Read Barrier) (e.g., LFENCE on x86). Prevents Load-Load reordering.

## Link

https://aijishu.com/a/1060000000458762

http://cnblogs.com/JiMoKuangXiangQu/articles/18812652

https://hugok.blog/article/Memory-Consistency-Models
