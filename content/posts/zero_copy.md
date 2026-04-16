---
date: '2026-04-16T10:15:00+08:00'
draft: false
title: 'Zero-copy'
tags: ["OS", "Linux", "IO"]
summary: "Zero-copy techniques in Linux — starting from the traditional read/write path (4 context switches, 2 DMA + 2 CPU copies) and walking through Direct I/O, mmap, sendfile, DMA gather, splice, and COW."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

## Concept

Avoiding data copying operations between different memory regions reduces data copying or context switching, thereby reducing CPU load.

## Traditional

Linux data transport mechanism：poll，I/O interrupt，DMA

**I/O interrupt：**

1. Call read [context switch]
2. kernel initiate I/O request to disk, data load into disk buffer
3. Send I/O interrupt to kernel
4. Transfer data from disk buffer to kernel buffer
5. Tranfer to user buffer [context switch]

**DMA:**

1. Call read [context switch]
2. Kernel initiate I/O request to DMA [cpu schedule]
3. DMA initiate I/O request to disk, data load into disk buffer
4. Disk signals DMA controller，DMA copy data from disk buffer to kernel buffer
5. Send I/O interrupt to kernel
6. Transfer to user buffer [context switch]

**Analysis：**

4 context switch 2 DMA copy 2 CPU copy

## Impls

Three ways to implement zero-copy

1. Direct I/O
2. Reduce data copies
3. Copy-On-Write

### Direct I/O

open with O_DIRECT， pypass kernel buffer cache

### Reduce data copies

**mmap + write**

Replace read + write, reduce 1 CPU copy(kernel to user)

**sendfile** [non modify]

copy in the kernel through fd (read buffer -> socket buffer), reduce 2 context switch and 1 CPU copy

**sendfile + DMA gather copy** [non modify]

Zero CPU copy, only transfer fd and data_len to soocket buffer, DMA directy transfer from read buffer to NIC based on the fd and data_len

**splice** [non modify]

set pipeline to avoid CPU copy

### COW

`Fork`  create the child process which shares the parent's memory until it tries to write data, triggering the kernel to copy only that specific page.

## Link

https://zhuanlan.zhihu.com/p/83398714

https://xiaolincoding.com/os/8_network_system/zero_copy.html
