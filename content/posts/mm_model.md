---
date: '2026-04-16T10:10:00+08:00'
draft: false
title: 'Physical Memory Model'
tags: ["OS", "Linux", "Memory"]
summary: "How Linux organizes physical memory — comparing FLATMEM, DISCONTIGMEM, and SPARSEMEM, and how each model implements pfn_to_page / page_to_pfn."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

## Physical Memory Model

Physical memory in a system may be addressed in different ways. Linux abstracts this diversity using one of the two memory models: FLATMEM and SPARSEMEM.

Evetry memory model define the way to manage `struct page` arrays, which define `pfn_to_page` and `page_to_pfn` for the transfer to pfn and page

### FLATMEM

The Flat Memory Model treats the entire physical address space as a single, continuous array of page frames.

With FLATMEM, the conversion between a PFN and the `struct page` is straightforward: PFN - ARCH_PFN_OFFSET is an index to the mem_map array.The ARCH_PFN_OFFSET defines the first page frame number for systems with physical memory starting at address different from 0.

### DISCONTIGMEM

{{< img src="/images/DISCONTIGMEM.png" alt="DISCONTIGMEM memory model" size="mid" >}}

Designed for early NUMA systems, this model splits memory into distinct "nodes," each having its own local memory map.
It avoids wasting memory on large gaps between nodes but increases the computational overhead for converting physical addresses to page structures.

`page_to_pfn` 与 `pfn_to_page` 的计算逻辑就比 FLATMEM 内存模型下的计算逻辑多了一步定位 `page` 所在 `node` 的操作。

- 通过 `arch_pfn_to_nid` 可以根据物理页的 PFN 定位到物理页所在 `node`。
- 通过 `page_to_nid` 可以根据物理页结构 `struct page` 定义到 `page` 所在 `node`。

当定位到物理页 `struct page` 所在 `node` 之后，剩下的逻辑就和 FLATMEM 内存模型一模一样了。

```c
#if defined(CONFIG_DISCONTIGMEM)

#define __pfn_to_page(pfn)			\
({	unsigned long __pfn = (pfn);		\
	unsigned long __nid = arch_pfn_to_nid(__pfn);  \
	NODE_DATA(__nid)->node_mem_map + arch_local_page_offset(__pfn, __nid);\
})

#define __page_to_pfn(pg)						\
({	const struct page *__pg = (pg);					\
	struct pglist_data *__pgdat = NODE_DATA(page_to_nid(__pg));	\
	(unsigned long)(__pg - __pgdat->node_mem_map) +			\
	 __pgdat->node_start_pfn;					\
})
```

### SPARSEMEM

{{< img src="/images/SPARSEMEM.png" alt="SPARSEMEM memory model" size="mid" >}}

The previous Discontiguous Model managed memory based on hardware "Nodes" (which vary in size). SPARSEMEM abstracts memory into fixed-size blocks called "Sections", decoupling memory management from the physical node layout.

Physical memory is managed in blocks called "Sections" (struct mem_section).Each section contains section_mem_map, which points to the array of struct page for that section.

There are two possible ways to convert a PFN to the corresponding `struct page` - a "classic sparse" and "sparse vmemmap". The selection is made at build time and it is determined by the value of CONFIG_SPARSEMEM_VMEMMAP.

- The classic sparse encodes the section number of a page in page->flags and uses high bits of a PFN to access the section that maps that page frame. Inside a section, the PFN is the index to the array of pages.

- The sparse vmemmap uses a virtually mapped memory map to optimize pfn_to_page and page_to_pfn operations. There is a global `struct page` *vmemmap pointer that points to a virtually contiguous array of `struct page` objects. A PFN is an index to that array and the offset of the `struct page` from vmemmap is the PFN of that page.

## Link

physical memory model:

https://www.cnblogs.com/binlovetech/p/16914715.html
