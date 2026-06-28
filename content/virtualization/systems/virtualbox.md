---
date: '2026-06-27T15:00:00+08:00'
draft: false
title: 'Virtualization Systems — VirtualBox'
slug: 'virtualbox'
tags: ["Virtualization", "Hypervisor", "Systems", "VirtualBox"]
series: ["Virtualization Series"]
summary: "Oracle's cross-platform desktop Type-2 hypervisor. Ships its own kernel module (vboxdrv) per host OS family rather than using KVM; read through the lens of the portability tax that this 'be your own kernel module' choice imposes."
author: "Anekoique"
ShowToc: true
ShowBreadCrumbs: true
---

VirtualBox is the **desktop Type-2 hypervisor** — a hosted VMM with first-class support for macOS, Windows, Linux, and Solaris hosts, designed primarily for *desktop* virtualization workloads (running a guest OS on a developer's laptop, running test environments, isolating untrusted software). It was released by Innotek in 2007, acquired by Sun in 2008, and has been an Oracle product since 2010. The core ("OSE", Open Source Edition) is dual-licensed under GPL v3 and CDDL; closed-source extensions (USB 2/3, RDP server, PXE ROM, disk encryption) ship as an "Extension Pack" under a proprietary license.

What makes VirtualBox worth reading carefully — and what makes it different from every other Type-2 hypervisor in this survey — is that it predates the KVM consolidation. VirtualBox launched the same year KVM was upstreamed (2007), but chose to ship its **own kernel module** (`vboxdrv`) rather than depend on the host's. The architectural cost is real (one kernel module per host OS family, maintained by the VirtualBox team), but the benefit is the cross-platform property: VirtualBox is the only VMM in this survey that runs on macOS, Windows, *and* Linux as a first-class product. Where KVM and QEMU built a Linux-only stack, VirtualBox built a portable stack — and the design choices reflect that goal throughout.

This note follows the structure established in [Docker](/virtualization/systems/docker/) / [Kata](/virtualization/systems/kata/) / [Firecracker](/virtualization/systems/firecracker/) — VirtualBox's actual shape, not a forced §-template. The organizing principle is **portability tax**: many of VirtualBox's architectural decisions exist to support the multi-host story, and each one is informative for understanding the cost of "be your own kernel module" versus "use the host's kernel module". Source citations name canonical paths in the OSE tree (`src/VBox/VMM/`, `src/VBox/HostDrivers/Support/`, `src/VBox/Frontends/`, etc.). No pinned commit; paths are stable across recent VirtualBox 7.x releases.

## §02 — Taxonomy: VirtualBox at a glance

| Axis | VirtualBox |
|---|---|
| Placement | **Type-2 hosted** — runs on top of an existing host OS (macOS / Windows / Linux / Solaris), with its own kernel module providing hardware virtualization access |
| Guest interface | **Full virtualization** with extensive paravirt accelerators via "Guest Additions" (paravirt drivers for graphics, mouse, shared folders, clipboard, drag-and-drop) — unmodified guests work, but cooperating guests get a much better experience |
| Hardware support | **Required** in modern versions: VT-x / AMD-V (raw mode with binary translation was supported through 6.0, removed in 6.1, 2019); optionally VT-d/AMD-Vi for passthrough; nested-virt as of 6.0+ |
| Isolation boundary | **Hardware** (per-VM EPT/NPT + VMX non-root mode) at the VM boundary; the VMM userspace process is one of many on the host with no special isolation |

The defining structural choice is **own-kernel-module portability**. VirtualBox doesn't use KVM on Linux, doesn't use Hyper-V on Windows (though it can coexist with it), doesn't use Hypervisor.framework on macOS (though recent versions optionally do). Instead, it has its own kernel driver — `vboxdrv` — implemented per-host-OS-family, sitting in the kernel and handling all hardware-virtualization concerns directly. This is a major architectural commitment: each supported host OS family needs its own maintained kernel-side code. The benefit is that the host-userspace VMM is uniform across all hosts.

Three rules to internalize:

1. **VirtualBox is QEMU's contemporary, not its descendant.** When VirtualBox launched in 2007, QEMU+KVM was *also* new. The two went in opposite directions: KVM consolidated on Linux as a kernel feature, while VirtualBox built portability at the cost of maintaining its own kernel side. Reading VirtualBox is reading "what if you'd taken the other fork in 2007".
2. **VirtualBox is a desktop product, not a server product.** Its design priorities are different from KVM/Firecracker/Kata: GUI, snapshots, seamless integration with the host (shared folders, clipboard, drag-and-drop), USB pass-through, Guest Additions. The hypervisor parts are competitive with server hypervisors but the user-facing surface is much larger and more concerned with host-guest interaction.
3. **The "OSE" / Extension Pack split is significant.** The core hypervisor, virtual hardware, snapshots, headless operation, and most guest support are in the open-source core. USB 2/3 controller (xHCI/EHCI), VirtualBox Remote Desktop Protocol (VRDP), PXE boot, disk encryption, and a few other features are in the closed Extension Pack. The closed parts are user-facing conveniences, not the architectural core; reading the OSE tells you almost everything about how VirtualBox actually works.

## The stack

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  User-facing frontends                                           │
   │  - VirtualBox.app / VirtualBox.exe (Qt GUI)                      │
   │  - VBoxManage (CLI; the complete API)                            │
   │  - VBoxHeadless (no-GUI VM execution)                            │
   │  - VBoxSDL (simple SDL display)                                  │
   │  - VirtualBox Web Service / VBoxWebSrv                           │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │ XPCOM / COM RPC (the "Main API")
                                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  VBoxSVC — the service daemon                                    │
   │  - per-host singleton, manages all VMs                           │
   │  - VirtualBox.xml config database                                │
   │  - VM lifecycle orchestration                                    │
   │  - snapshots, settings, lockfile management                      │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │ COM/XPCOM, spawns per-VM processes
                                         ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  VBoxHeadless / VirtualBoxVM (one per running VM)                │
   │  ┌────────────────────────────────────────────────────────────┐  │
   │  │  VMM userspace ("VBoxVMM.dll" / libVBoxVMM)                │  │
   │  │  - vCPU thread(s)                                          │  │
   │  │  - virtual hardware (chipset, BIOS, devices)               │  │
   │  │  - PDM (Pluggable Device Manager) — the device framework   │  │
   │  └─────────────────────────────┬──────────────────────────────┘  │
   │  ┌─────────────────────────────▼──────────────────────────────┐  │
   │  │  SUPDrv user-side API (libVBoxRT, sup*.cpp)                │  │
   │  │  - the only path from userspace to vboxdrv                 │  │
   │  └─────────────────────────────┬──────────────────────────────┘  │
   └────────────────────────────────┼──────────────────────────────────┘
                                    │  ioctl on /dev/vboxdrv (or
                                    │  equivalent per host OS)
                                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  vboxdrv — the kernel module (one implementation per host OS)    │
   │  - hardware virtualization setup (VT-x / AMD-V world-switch)     │
   │  - guest physical memory management                              │
   │  - host-OS abstraction layer                                     │
   │  - one of: vboxdrv.ko (Linux), VBoxDrv.kext (macOS),             │
   │            VBoxDrv.sys (Windows), vboxdrv (Solaris)              │
   └─────────────────────────────────────┬────────────────────────────┘
                                         │  VMX VMLAUNCH / VMRESUME
                                         ▼  (or VMRUN for AMD)
                            ┌─────────────────────────────┐
                            │  Guest VM                   │
                            │  - PC chipset (PIIX3/ICH9)  │
                            │  - VBoxBIOS / EFI firmware  │
                            │  - guest OS                 │
                            │  - optional Guest Additions │
                            │    (paravirt drivers)       │
                            └─────────────────────────────┘
```

Several things to notice in contrast to the other Type-2 systems studied:

1. **There's an extra daemon (VBoxSVC) above the per-VM processes.** Unlike Firecracker (no daemon — orchestration is external) or QEMU+libvirt (libvirt is *one possible* daemon, not required), VirtualBox's VBoxSVC is mandatory — it owns the VM database and brokers all multi-VM operations. This reflects VirtualBox's "single-user desktop" history: one human, many VMs, one settings store.
2. **The kernel module is VirtualBox's own.** Where QEMU+KVM uses Linux's `kvm.ko`, VirtualBox ships `vboxdrv` — a kernel module maintained by the VirtualBox project, ported separately to each host OS family. This is the single most expensive architectural commitment in the project.
3. **The "Main API" is a COM/XPCOM interface.** VirtualBox's IPC layer is XPCOM (Mozilla's lightweight COM) on Linux/macOS, real COM on Windows. Every frontend (GUI, CLI, web service) talks to VBoxSVC over this. This is also a portability choice — at the time VirtualBox was designed (mid-2000s), XPCOM was the available cross-platform RPC story for desktop apps; gRPC and similar didn't exist yet.

## vboxdrv — the kernel module

`vboxdrv` (in `src/VBox/HostDrivers/Support/`) is VirtualBox's kernel-side equivalent of KVM. Reading what it does is the most important architectural lesson the system offers.

### Why VirtualBox ships its own kernel module

The straightforward question: why not just use KVM on Linux, Hyper-V on Windows, Hypervisor.framework on macOS? The answers are historical and pragmatic:

1. **KVM in 2007 wasn't yet what it is today.** The KVM ABI was new, only on Linux, and didn't yet support all the things VirtualBox needed. Innotek had already been working on VirtualBox for several years before KVM existed. Switching to KVM would have meant rewriting the kernel-side code *and* losing Windows/macOS support.
2. **Each host OS has a different hypervisor framework.** Linux has KVM, Windows has Hyper-V (and earlier had nothing), macOS has Hypervisor.framework (since macOS 10.10, 2014). Targeting each one separately means different kernel-side code per host *and* different user-side adaptors. VirtualBox's choice was to have one kernel-side code (per host's syscall conventions) and one user-side code (truly uniform).
3. **Owning the kernel-side code gives feature control.** VirtualBox can add features without waiting for kernel maintainers to accept them. Snapshots, nested paging tweaks, exception-handling experiments — all done in `vboxdrv`. This is the same control argument that motivated Xen's hypervisor or VMware's VMM kernel.
4. **Recent versions optionally use host hypervisor frameworks.** VirtualBox 7.0+ on macOS supports Apple's Hypervisor.framework instead of `vboxdrv.kext` (driven by Apple's increasing restrictions on third-party kernel extensions). VirtualBox on Windows can coexist with Hyper-V via Windows Hypervisor Platform. The trend is toward delegation when host platforms make it viable, but the original `vboxdrv` design remains the cross-platform default.

### What vboxdrv actually does

The kernel module's job, in essence: **set up hardware virtualization so the userspace VMM can run guest code, and handle the host-OS-specific glue that doing so requires.**

Concretely:

- **VT-x / AMD-V setup**: enables VMX root mode on each CPU at module load time (`VMXON`), allocates per-CPU VMCS regions, configures host-state areas.
- **World-switch**: the actual `VMLAUNCH` / `VMRESUME` of guest code happens in `vboxdrv` (or in userspace assembly called from `vboxdrv`, depending on the path). When the guest VM-exits, control returns to `vboxdrv`, which decides whether to handle it in-kernel or pass it up to userspace.
- **Guest physical memory management**: pins host pages backing guest memory, sets up Extended Page Tables (EPT) / Nested Page Tables (NPT) mapping guest-physical to host-physical addresses.
- **Host-OS abstraction (the "host driver" layer)**: provides a uniform interface that the rest of VirtualBox sees, mapping each operation onto host-OS-specific implementations:
  - Page allocation: `__get_free_pages` on Linux, `MmAllocatePagesForMdl` on Windows, `IOMallocContiguous` on macOS.
  - Per-CPU operations: `smp_call_function_single` on Linux, `KeIpiGenericCall` on Windows.
  - Timer access: per-host APIs for high-resolution timers.
- **IRQ management**: registers handlers for the timer interrupts the VMM uses for scheduling guests.

The host-OS abstraction is the largest part of the maintenance burden. Each new Linux kernel release can break `vboxdrv` if it changes an internal API; VirtualBox has separate "shims" for kernel ABI evolution. macOS kernel extension changes (Apple's signing/sealing changes since macOS 10.13) require continuous adaptation. Windows requires WHQL signing.

### The SUPDrv interface

The user-side library `libVBoxRT` exposes a stable API for the VMM to talk to `vboxdrv`. This is called the **SUPDrv** interface ("SUPport Driver"). It is the single point of entry from VirtualBox userspace to VirtualBox kernel.

The API includes:

- `SUPR3PageAllocEx` — allocate guest-physical memory backing pages.
- `SUPR3GIPMap` — map the Global Information Page (a shared structure for clock synchronization).
- `SUPR3CallVMMR0Ex` — call into the kernel-side VMM (the VM execution path).
- `SUPR3HardenedMain` — bootstrap a "hardened" process (see security section below).
- `SUPR3IoCtl` — generic ioctl-like passthrough for VMM operations.

The pattern mirrors KVM's `/dev/kvm` ioctls (covered in [KVM](/virtualization/systems/kvm/)): a fixed-shape ABI between userspace and kernel. The difference is that VirtualBox controls both sides, so the API can evolve to match VMM needs without external negotiation. The cost is that documentation, audit, and stability all fall to the VirtualBox team alone.

### Comparison to KVM's design

| Concern | KVM | vboxdrv |
|---|---|---|
| Hosts supported | Linux only | Linux + Windows + macOS + Solaris |
| Maintained by | Linux kernel community | VirtualBox / Oracle |
| API stability | Long-term per host kernel | Project-controlled |
| Per-host code | One implementation | One per host OS family |
| Userspace partner | QEMU/Firecracker/crosvm/etc. | Always VirtualBox userspace |
| Total kernel-side LoC | ~75 KLoC | ~50 KLoC (per host) + ~30 KLoC shared |
| Distribution | In-tree with Linux | Out-of-tree per host |

The portability story has a real cost: VirtualBox's kernel-side is roughly the same size as KVM, but maintained 4× over for the four host OS families it supports. Whether this is "worth it" depends on the value of cross-platform — for desktop use, where users want to install VirtualBox on whatever laptop they have, this has historically been the killer feature.

## The userspace VMM

The per-VM process (`VBoxHeadless` for no-GUI, `VirtualBoxVM` for GUI) loads the VirtualBox VMM userspace library and runs the guest. The userspace VMM is in `src/VBox/VMM/` and is conceptually similar to QEMU's KVM accelerator (see [QEMU](/virtualization/systems/qemu/)'s accelerator framework section) — it does device emulation, BIOS loading, and exit handling, while delegating CPU/memory virtualization to `vboxdrv`.

### Main components

- **VM** (`src/VBox/VMM/VMMR3/VM.cpp`): top-level VM lifecycle. Creates the VM structure, sets up vCPUs, manages state transitions (poweroff → starting → running → paused → saved → destroyed).
- **CPUM** (CPU Manager): per-vCPU architectural state.
- **PGM** (Page Manager): guest physical memory.
- **MM** (Memory Manager): VMM-internal allocations.
- **IEM** (Interpreted Execution Mode): a software CPU interpreter, used for instruction emulation in certain edge cases (paged-but-not-translatable instructions, MMIO emulation that needs to decode the trapping instruction).
- **HM** (Hardware-Assisted Mode): the modern execution backend — talks to `vboxdrv` to run vCPUs in VMX/AMD-V.
- **NEM** (Native Execution Manager): newer execution backend using host hypervisor APIs directly (Hypervisor.framework on macOS, WHPX on Windows). Avoids `vboxdrv` for cases where the host's own hypervisor is available.
- **REM** (Recompiled Execution Mode): historical — the QEMU-borrowed binary translator. Removed in modern VirtualBox.
- **PDM** (Pluggable Device Manager): the device framework. See below.
- **VMM core** (in `src/VBox/VMM/VMMAll/` and `src/VBox/VMM/VMMR0/`): the actual exit-handling code that runs in `vboxdrv` context (R0 — ring 0) versus VMM userspace context (R3 — ring 3).

### The R3/R0 split

A pattern VirtualBox uses heavily: each VMM subsystem has **R3** (Ring 3, host userspace) and **R0** (Ring 0, kernel) parts, with names like `PGMR3` vs `PGMR0`. The R0 parts run inside `vboxdrv`'s context (in kernel mode); the R3 parts run in the per-VM userspace process. They share data via mapped memory.

Why split? Because some operations are so frequent or latency-sensitive that even a userspace round-trip is too expensive. For example, a guest page fault that should resolve into a no-op (the page is already mapped but the EPT entry needed permission update) can be handled entirely in R0 without ever returning to userspace. Less frequent operations (device emulation, BIOS reads, snapshot management) bubble up to R3.

The pattern is similar to KVM's "handle exit in kernel if possible, return to userspace otherwise" (see [KVM](/virtualization/systems/kvm/)'s exit dispatch table), but VirtualBox has more code in R0 because `vboxdrv` is theirs to extend. The trade is: faster fast paths, more code in the kernel TCB.

### PDM — the Pluggable Device Manager

PDM (`src/VBox/VMM/VMMR3/PDM*.cpp`) is VirtualBox's equivalent of QEMU's qdev (see [QEMU](/virtualization/systems/qemu/)'s qdev section). It manages the lifecycle and connectivity of virtual devices.

PDM concepts:

- **Devices**: virtual hardware (the chipset, BIOS, IDE controller, virtio devices, serial port, USB host controller, etc.). Each device is implemented as a C struct of function pointers, registered with PDM at VMM startup.
- **Drivers**: backends for devices. A virtio-net device frontend might be paired with a NAT engine driver, a bridged-network driver, or a host-only driver. PDM does the wiring.
- **Buses**: PCI, USB, etc. PDM manages bus enumeration and IRQ routing.
- **LUNs** (Logical Unit Numbers): the chain of drivers attached to a device. A virtio-blk device's "LUN0" might be a chain like virtio-blk → cache → VDI media driver, ending at the disk image file.

PDM is a simpler framework than QEMU's QOM+qdev — fewer levels of abstraction, no QMP-equivalent introspection, less runtime reflection. The reason is workload: VirtualBox doesn't try to support 30 architectures × 150 machine types × 300 devices the way QEMU does, so a simpler framework is sufficient. It's effectively one architecture (x86/x86_64, with experimental ARM in newer versions), one machine model (PC, with PIIX3 or ICH9 chipset choice), maybe 30-40 devices total.

### Device set

VirtualBox's emulated devices, roughly:

| Device | Notes |
|---|---|
| Chipset | PIIX3 (default) or ICH9 (modern, for newer guests) |
| BIOS | VirtualBox's own BIOS (or EFI for UEFI guests, via OVMF derivative) |
| IDE/SATA/SCSI/NVMe | Multiple storage controllers; SATA AHCI is the modern default |
| Floppy | For legacy guest installs |
| PS/2 keyboard + mouse | Default input |
| USB tablet | Better than PS/2 mouse for guest cursor tracking; needs Guest Additions or kernel USB driver |
| VGA / VBoxVGA / VBoxSVGA | Display adapters; VBoxSVGA is paravirt-accelerated |
| Sound (AC'97, ICH AC'97, HDA, SB16) | Audio devices |
| Network: PCnet (FAST III, PCnet II), Intel PRO/1000 (em, e1000), virtio-net | NIC choices, virtio-net is the fastest |
| USB host controller (OHCI, EHCI, xHCI) | OHCI in OSE; EHCI/xHCI in Extension Pack |
| Serial, parallel | Legacy I/O |
| RTC, APIC, IOAPIC, PIT, HPET | Standard PC platform |
| Smart card reader | For PIV / CAC cards |
| TPM (1.2, 2.0) | Virtual TPM |
| Virtio-net, virtio-scsi, virtio-balloon | Paravirt for cooperating guests |

The device set is **bigger than Firecracker's** (which is virtio-only, 8 devices) and **smaller than QEMU's** (300+ devices). It's tuned for the practical reality of running real desktop OSes (Windows, macOS [grey area], Linux, BSD) which expect a recognizable PC platform.

## The historical: ring deprivileging + binary translation

Before VT-x/AMD-V, VirtualBox ran guest code via a combination of ring deprivileging and limited binary translation — its "raw mode". This was VirtualBox's original execution backend and the one that distinguished it from VMware Workstation (which used full binary translation in software for the same era).

How raw mode worked:

- Guest ring-3 code ran directly on the host CPU at ring 3 — no virtualization needed.
- Guest ring-0 code was deprivileged: rewritten to run at ring 1 (a normally-unused privilege level on x86) and CPU-exception-trapped where it tried to execute privileged instructions.
- The trapped privileged instructions were *patched* (using a code-rewriting technique called "patch manager") to call into VirtualBox's VMM, which emulated them and returned.
- Memory was managed via shadow page tables — VirtualBox maintained a parallel page table that the hardware actually walked, mapping guest virtual to host physical, while the guest believed it was managing its own page tables.

Why this design existed: on Athlon CPUs before AMD-V, on Intel CPUs before VT-x, there was no other way to run an unmodified OS without doing full software emulation (QEMU TCG-style). Raw mode was VirtualBox's answer to "how do we run guest OSes faster than pure interpretation".

Why it was removed (raw mode was removed in VirtualBox 6.1 in 2019):

- All modern x86 CPUs have VT-x or AMD-V; the use case (no hardware virt available) doesn't exist anymore for any practical host.
- Maintaining raw mode meant maintaining the patch manager, shadow page tables, ring-1 deprivileging code — substantial code that handled rare corner cases (every privileged instruction the patch manager could encounter).
- Modern guest OSes (especially x86-64 long mode) made raw mode harder: long-mode segmentation differences broke ring deprivileging.

The historical lesson: VirtualBox's raw mode is the closest VirtualBox came to QEMU's TCG (binary translation) — both are software-only fallbacks for missing hardware virtualization. The fact that VirtualBox could remove raw mode while QEMU still ships TCG reflects different priorities: QEMU keeps TCG because cross-architecture emulation is part of its identity (user-mode, embedded development, kernel CI), while VirtualBox only ever cared about running x86 guests on x86 hosts, so once VT-x was universal, raw mode lost its purpose.

## Desktop-specific features

VirtualBox's most distinctive subsystem set, compared to every other VMM in this survey, is its **desktop integration**. None of KVM, QEMU, Firecracker, or Kata cares about clipboard sharing, drag-and-drop, or seamless windowing — those aren't server-VMM concerns. VirtualBox has all of them as first-class features.

### Snapshots

VirtualBox's snapshot model: at any time, the user can take a snapshot of a running (or stopped) VM. The snapshot captures:

- Guest memory state (written to a `.sav` file).
- vCPU state (saved as part of the same file).
- Virtual device state (PDM serializes each device).
- Differencing disk images: the current `.vdi`/`.vmdk` is frozen; new writes go to a child differencing image. Disks are "stacked" like Docker image layers, but at the block level.

The snapshot tree: snapshots can branch. From any snapshot, you can roll back, create a new snapshot, then have two children of the same parent. This produces a tree of states. VirtualBox's `.vbox` settings file tracks the tree topology.

Compared to other systems in the survey:

- **Firecracker's snapshot/restore** is a single-state operation: write a file, restore from file. No tree, no branching, no concept of children. Optimized for *warm pool* latency (covered in [Firecracker](/virtualization/systems/firecracker/)).
- **QEMU's snapshots** (qcow2 internal snapshots, or savevm/loadvm) similarly snapshot a single state, with qcow2 supporting limited differencing.
- **VirtualBox's snapshots** are deeply integrated with the user interface and tree-structured. Users can branch a VM into multiple parallel exploration paths. This is a desktop UX feature first and foremost.

### Guest Additions

Guest Additions (in `src/VBox/Additions/`) is a software package the user installs *inside* the guest OS. It provides paravirt drivers and userspace helpers for tight host-guest integration:

- **Paravirt video driver**: hardware-accelerated graphics, dynamic resolution change to match host window size, multiple monitors.
- **Mouse pointer integration**: the guest's mouse cursor moves seamlessly into and out of the VM window without explicit "capture/release".
- **Shared folders**: a host directory mounted inside the guest as a network-like filesystem (`vboxsf`). VirtualBox's own filesystem, not Plan 9 (9P) or virtio-fs — VirtualBox predates broad adoption of those.
- **Shared clipboard**: bidirectional clipboard sync between host and guest.
- **Drag and drop**: files can be dragged from host to guest and vice versa.
- **Time synchronization**: keeps guest time in sync with host (necessary because guest clock drift after pause/resume is significant).
- **Guest Property API**: host-readable key-value store the guest can write to (similar to QEMU's `fw_cfg` but bidirectional).
- **Automation**: scripted `VBoxControl` execution inside the guest from the host.

Guest Additions are open-source for Linux, BSD, Solaris guests; the Windows Guest Additions binary is closed-source (signed by Oracle for Windows kernel-mode driver requirements). The wire protocol between host and guest is called **HGCM** (Host Guest Communication Manager) and runs over a VirtualBox-specific paravirt device.

### Seamless mode and unity-like features

VirtualBox can render guest windows directly on the host desktop, with the VM "frame" removed — guest application windows appear to be host windows. This requires the guest video driver (Guest Additions) to communicate window rectangle information to the host VMM, which then composites accordingly.

### USB pass-through

VirtualBox can pass host USB devices to the guest. USB 1.1 (OHCI) is in the OSE; USB 2.0 (EHCI) and USB 3.0 (xHCI) require the Extension Pack. The implementation: VirtualBox claims the device from the host's USB stack, then exposes it to the guest's USB host controller emulation.

This is one of the features that's hard to do in server-focused VMMs (Firecracker has nothing analogous; QEMU has support but it's complex to wire up) and a major reason VirtualBox is preferred for desktop scenarios needing USB device access (USB-to-serial adapters, hardware development boards, certain authentication tokens).

### VirtualBox Remote Desktop Protocol (VRDP)

VRDP is a VirtualBox-specific remote desktop protocol, RDP-compatible at the wire level. It lets users connect to a running VM as if it were a remote desktop, useful for headless VMs and for accessing VMs from another machine.

VRDP server is in the closed Extension Pack; clients are standard RDP clients (mstsc, Remmina, etc.).

### Disk encryption

The Extension Pack provides per-disk-image encryption (AES-128/256), with the password supplied at VM start. This is useful for the desktop use case of "I have sensitive VMs on a laptop and want them encrypted at rest even if the laptop is stolen".

The OSE doesn't include this; users wanting open-source disk encryption typically use LUKS inside the guest.

## The VBoxSVC daemon and the Main API

VBoxSVC (in `src/VBox/Main/`) is the per-host daemon that coordinates all VMs. It's the central control point for VirtualBox operations.

### What VBoxSVC does

- **Owns the VM database**: `~/.config/VirtualBox/VirtualBox.xml` lists all known VMs; each VM has its own `.vbox` settings file. VBoxSVC reads, writes, and brokers access to these files.
- **VM lifecycle**: starting a VM means VBoxSVC spawns a per-VM process and waits for it to ready up.
- **Settings management**: changing a VM's configuration (RAM size, attached disks, network interfaces) goes through VBoxSVC, which writes back to the `.vbox` file.
- **Snapshots**: snapshot creation, deletion, restore, branching — all orchestrated by VBoxSVC (the actual memory/state write happens in the per-VM process, but the tree topology and disk-image management is VBoxSVC's).
- **Lock management**: prevents two frontends from concurrently modifying the same VM.

VBoxSVC is the closest VirtualBox has to libvirt's `libvirtd` (the per-host VM-management daemon for QEMU). It centralizes what could otherwise be many duplicate daemons.

### The Main API

VBoxSVC exposes a programmatic API called the **Main API** (`src/VBox/Main/idl/VirtualBox.xidl`), defined as a set of XPCOM/COM interfaces. The IDL describes objects like `IVirtualBox` (the root), `IMachine` (one VM), `ISession` (a controlling session over a VM), `IConsole` (the running VM's runtime API), `IProgress` (async operation tracking).

Bindings exist for: C++, Python, Java, JavaScript, Visual Basic, .NET. The `VBoxManage` CLI is itself a Main API client.

This is a more sophisticated control plane than Firecracker's REST or QEMU's QMP for *programmatic control* — typed object model, asynchronous progress tracking, event subscriptions. The cost is complexity: the COM/XPCOM machinery is large, and the API is verbose.

### Frontends

The user-facing frontends:

| Frontend | What it is |
|---|---|
| **VirtualBox.app / VirtualBox.exe** | Qt-based GUI; the default desktop frontend |
| **VBoxManage** | Comprehensive CLI; can do anything the GUI can |
| **VBoxHeadless** | Headless VM execution (no GUI, optional VRDP server) |
| **VBoxSDL** | Minimal SDL-based display (no GUI chrome) |
| **VBoxWebSrv** | SOAP web service; exposes the Main API over HTTP |
| **vboxshell.py** | Interactive Python shell using the Main API |

All of these are Main API clients. The pattern: one fat API, many thin frontends.

## Security: hardened VMs

VirtualBox's per-VM process runs with elevated privileges (it needs to talk to `vboxdrv` via the SUPDrv ioctl, which is privileged). To prevent the VMM process from being compromised by a malicious *frontend* (a setuid-style attack), VirtualBox uses a mechanism called **hardened security**.

The mechanism:

1. Per-VM processes are setuid-root (Linux) or have elevated privileges (Windows).
2. On startup, `SUPR3HardenedMain` runs: it verifies the binary's signature, checks that the binary path is in an expected location, and re-executes itself if necessary to drop privileges.
3. After verification, the process drops privileges as far as possible while retaining the ability to call into `vboxdrv`.

This is the *kernel-protecting* analog of Firecracker's jailer (see [Firecracker](/virtualization/systems/firecracker/)). The threat models are different — Firecracker's jailer assumes the VMM may be compromised by a guest and limits blast radius; VirtualBox's hardening assumes the VMM may be compromised by a frontend and limits what the frontend can do. Both ultimately try to keep guest-domain compromise from escalating to host root.

VirtualBox does *not* have a strong sandbox around the running VMM process the way Firecracker+jailer does. The hardened-start verifies *integrity*; it doesn't apply seccomp filters or namespace isolation to limit the VMM's syscall surface. This is a security gap relative to Firecracker — defensible in the desktop context (the threat model assumes the user owns the host) but a weakness for any multi-tenant use.

## Storage formats

VirtualBox supports several disk image formats:

| Format | Notes |
|---|---|
| **VDI** | VirtualBox's native format. Sparse, supports differencing (snapshots), online resize, compaction |
| **VMDK** | VMware's format; full read/write support for compatibility |
| **VHD/VHDX** | Microsoft's format; useful for moving disks between VirtualBox and Hyper-V |
| **HDD** | Parallels' format; less common |
| **Raw** | Just a flat file or block device |

VDI is the default. The differencing-image mechanism is what backs snapshots: a snapshot freezes the parent VDI and creates a child VDI containing only deltas. Restoring a snapshot deletes the child; deleting a snapshot merges the child back into the parent.

The format-agnosticism mirrors QEMU's block layer (see [QEMU](/virtualization/systems/qemu/)'s block-layer section), though without the same level of composability. VirtualBox doesn't have QEMU's "qcow2 over throttle over luks over raw" graph; it has one image format per disk, with snapshots as a separate concept.

## Performance

VirtualBox's performance is bounded by its position: it's a desktop VMM, prioritizing compatibility over raw throughput.

| Workload | Native | VirtualBox |
|---|---|---|
| CPU-bound | 1.0× | ~0.95-0.98× |
| Memory-bound | 1.0× | ~0.95× |
| Storage (virtio-blk to file) | 1.0× | ~0.7-0.9× depending on cache mode |
| Storage (virtio-blk to host block dev) | 1.0× | ~0.85-0.95× |
| Network (virtio-net) | 1.0× | ~0.6-0.8× |
| Network (Intel e1000 emulation) | 1.0× | ~0.3-0.5× |
| Graphics (with paravirt VBoxSVGA + GA) | n/a (host GPU) | acceptable for desktop, not gaming |

Several observations:

- **CPU and memory are competitive with KVM-based hypervisors** (within a few percent). This is because the actual CPU virtualization is VT-x/AMD-V, the same hardware feature KVM uses. The userspace-VMM and kernel-module overheads are slightly different but small.
- **Networking is the headline weak spot**, especially for emulated NICs (PCnet, e1000) where every packet costs a VM-exit. virtio-net is better but still slower than KVM+vhost-net (which VirtualBox doesn't use — there's no equivalent of vhost in `vboxdrv`).
- **Storage performance depends heavily on cache mode**. The default ("write-back") is fast but has crash-consistency caveats; "write-through" is safer but slower.
- **Graphics is *the* feature that justifies VirtualBox for desktop use**. With Guest Additions installed, VBoxSVGA gives accelerated 2D/3D rendering, dynamic resolution, multi-monitor. No server-focused VMM has comparable graphics support.

VirtualBox is not competitive with KVM+QEMU for server workloads (throughput is lower; per-VM overhead is higher) and not competitive with Firecracker for microVMs (start time is several seconds; memory overhead is ~100 MB per VM). It is, however, the most-used hypervisor for **desktop scenarios** where neither metric matters and where Guest Additions + GUI + cross-platform are the killer features.

## Where VirtualBox sits in the design space

Updated comparison table including VirtualBox alongside the other Type-2 hypervisors:

| System | Isolation | TCB | Hosts | Code size | Workload class |
|---|---|---|---|---|---|
| QEMU+KVM | Hardware (VT-x + EPT) | Linux + KVM + QEMU (~1.5 MLoC C) | Linux only | Large | Universal: cloud, dev, embedded, kernel CI |
| Firecracker | Hardware (VT-x + EPT) + Rust + jailer | Linux + KVM + Firecracker (~50 KLoC Rust) | Linux only | Tiny | Cloud serverless / microVM |
| Kata Containers | Hardware via underlying VMM (often Firecracker) | Guest kernel + VMM + host kernel + Kata runtime | Linux only | ~80 KLoC | Containers needing hypervisor isolation |
| gVisor | Software (userspace kernel reimpl) | Sentry + Gofer + small host kernel | Linux only | ~500 KLoC Go | Multi-tenant userspace isolation |
| **VirtualBox** | **Hardware (VT-x + EPT) + own kernel module** | **Host kernel + vboxdrv + VBoxVMM + frontend (~1.5 MLoC C++)** | **macOS + Windows + Linux + Solaris** | **Large** | **Desktop: dev VMs, test envs, retro OS, USB device access** |
| Docker | Software (kernel feature flags) | Entire Linux kernel | Linux only | ~50 KLoC core + kernel | Native-perf shared-kernel containers |

VirtualBox's distinctive cell: **the only Type-2 hypervisor in this survey running on multiple host OS families**. The cost is the own-kernel-module commitment; the benefit is the cross-platform property that makes VirtualBox the practical choice for desktop scenarios where the user's host OS isn't Linux.

The other distinctive feature: **workload class is desktop, not server**. VirtualBox's GUI, snapshots, USB pass-through, Guest Additions, shared folders, clipboard, drag-and-drop are all desktop concerns. The Type-2 hypervisors that won the cloud (QEMU+KVM, Firecracker) didn't compete on these axes because their workload doesn't need them.

## Architecture matrix

| Topic | VirtualBox |
|---|---|
| **Placement** | Type-2 hosted, cross-platform |
| **Guest CPU** | VT-x / AMD-V via vboxdrv; one vCPU thread per guest CPU |
| **Guest memory** | EPT/NPT-backed; pinned host pages |
| **Address space** | Standard VMX non-root; PGM (Page Manager) maintains EPT |
| **Hardware support** | Required (modern): VT-x / AMD-V; optional VT-d/AMD-Vi for passthrough; nested-virt supported |
| **CPU virtualization mechanism** | VT-x / AMD-V via vboxdrv (or, optionally, host hypervisor API on macOS/Windows) |
| **Memory virtualization mechanism** | EPT / NPT |
| **Device emulation** | ~30-40 devices: chipset (PIIX3/ICH9), BIOS/EFI, storage controllers (IDE/SATA/SCSI/NVMe), virtio-net/blk/balloon, USB host controllers, video adapters, sound, NIC, RTC, APIC, etc. |
| **Filesystem (shared with host)** | Shared Folders via `vboxsf` (VirtualBox-specific filesystem; not 9P or virtio-fs) |
| **Networking** | NAT, bridged, internal, host-only, NAT network; via tap or NDIS on the host |
| **Storage** | VDI (native), VMDK, VHD/VHDX, HDD, raw; differencing-image-based snapshots |
| **Hypercall ABI** | None significant; HGCM for Guest-Additions communication via paravirt device |
| **Snapshots** | Tree-structured; saves memory + state + differencing disk |
| **Live migration** | Limited (teleportation feature exists but is unmaintained in practice) |
| **Control plane** | Main API (XPCOM/COM); VBoxSVC daemon; multiple frontends (Qt GUI, CLI, web, SDL) |
| **TCB** | Host kernel + vboxdrv + VBoxVMM userspace + frontend |
| **Startup time** | Seconds (boot a guest OS through BIOS); snapshot-restore much faster |
| **Per-syscall overhead** | Zero in-guest |
| **Steady-state CPU overhead** | ~2-5% on VT-x/AMD-V capable hardware |
| **Memory overhead** | ~100-200 MB VMM (VBoxVMM + Qt + dependencies) per running VM |

One-sentence summary: **VirtualBox is the design that gets cross-platform desktop Type-2 virtualization by maintaining its own kernel module per host OS family, paying for it in maintenance burden and binary size, gaining the property that users can install the same product on macOS, Windows, Linux, and Solaris and get the same VMs running.**

## Source map

```text
VirtualBox (Open Source Edition, OSE)
├── src/VBox/                          — bulk of the codebase
│   ├── HostDrivers/                   — host-OS kernel modules
│   │   ├── Support/                   — vboxdrv core; per-host implementations
│   │   │   ├── linux/                 — Linux-specific vboxdrv code
│   │   │   ├── darwin/                — macOS-specific vboxdrv code
│   │   │   ├── win/                   — Windows-specific vboxdrv code
│   │   │   └── solaris/               — Solaris-specific vboxdrv code
│   │   ├── VBoxNetFlt/                — host network bridge driver
│   │   ├── VBoxNetAdp/                — host-only network driver
│   │   └── VBoxUSB/                   — host USB capture (OSE: limited)
│   ├── VMM/                           — the VMM core
│   │   ├── VMMR3/                     — Ring 3 (userspace) VMM code
│   │   │   ├── VM.cpp, VMM.cpp        — top-level VM lifecycle
│   │   │   ├── PGM*.cpp               — Page Manager (R3)
│   │   │   ├── CPUM*.cpp              — CPU Manager (R3)
│   │   │   ├── HM*.cpp                — Hardware-Assisted Mode glue
│   │   │   ├── NEM*.cpp               — Native Execution (Hypervisor.framework, WHPX)
│   │   │   ├── IEM*.cpp               — Interpreted Execution Mode
│   │   │   └── PDM*.cpp               — Pluggable Device Manager
│   │   ├── VMMR0/                     — Ring 0 (kernel) VMM code (runs in vboxdrv)
│   │   ├── VMMAll/                    — Shared R3/R0 code
│   │   └── include/                   — Headers for the VMM
│   ├── Main/                          — VBoxSVC and Main API
│   │   ├── idl/                       — XPCOM/COM IDL definitions
│   │   ├── src-server/                — VBoxSVC implementation
│   │   ├── src-client/                — Client-side API helpers
│   │   └── glue/                      — Language bindings glue
│   ├── Frontends/                     — User-facing frontends
│   │   ├── VirtualBox/                — Qt-based GUI
│   │   ├── VBoxManage/                — CLI
│   │   ├── VBoxHeadless/              — Headless runner
│   │   ├── VBoxSDL/                   — SDL display
│   │   └── VBoxShell/                 — Python shell
│   ├── Devices/                       — Device implementations (PDM devices)
│   │   ├── Bus/                       — PCI, USB bus emulation
│   │   ├── Storage/                   — IDE, SATA, SCSI, NVMe controllers
│   │   ├── Network/                   — e1000, virtio-net, etc.
│   │   ├── Audio/                     — sound devices
│   │   ├── Graphics/                  — VGA, VBoxVGA, VBoxSVGA
│   │   ├── PC/                        — chipset, BIOS, APIC, IOAPIC, PIT, HPET, RTC
│   │   └── Input/                     — keyboard, mouse, tablet
│   ├── Additions/                     — Guest Additions
│   │   ├── linux/, darwin/, solaris/  — Per-guest-OS additions
│   │   ├── common/                    — Shared GA code
│   │   └── WINNT/                     — Windows GA (closed source)
│   ├── NetworkServices/               — Built-in network services
│   │   ├── Dhcpd/                     — Internal DHCP server
│   │   └── NAT/                       — User-mode NAT engine (libslirp-based)
│   ├── Runtime/                       — IPRT (Independent Portable Runtime), VirtualBox's portable C runtime
│   └── Disassembler/                  — Used by IEM and patch manager
└── include/                           — Public headers
```

## Relationship to Astervisor

VirtualBox is the *least* Astervisor-aligned system in this survey. It's a C++ codebase, large, with workload concerns (desktop UX, USB pass-through, Guest Additions) that don't map to Astervisor's. The lessons are mostly contrasts.

| Choice | VirtualBox | Astervisor (planned) |
|---|---|---|
| Language | C++ | Rust |
| Codebase size | ~1.5 MLoC | Small, TCB-bounded |
| Workload class | Desktop virtualization | Language-isolated cooperating domains |
| Cross-platform | macOS + Windows + Linux + Solaris | Asterinas only |
| Kernel-side code | Per-host kernel module (vboxdrv) | OSTD provides hardware abstraction |
| Hypervisor approach | Type-2 with own kernel module | Type-1 framekernel |

### Cautionary lessons

- **Owning your own kernel module is expensive forever.** VirtualBox's `vboxdrv` requires per-host porting effort that has been ongoing for 18 years. Each Linux kernel release potentially breaks the module; macOS kernel-extension policies have repeatedly forced redesigns; Windows WHQL signing is a continuous overhead. Astervisor's choice to build *on* OSTD rather than ship its own kernel is the right counter-example to follow: depend on a well-defined kernel/framework interface, not on the entire host kernel ABI.
- **The R3/R0 split is a maintenance hazard.** VirtualBox's habit of having both R3 and R0 implementations of subsystems (`PGMR3` and `PGMR0`, etc.) means two parallel codebases that must stay in sync. Astervisor's "OSTD provides primitives, visor uses them safely" model is structurally cleaner; resist the temptation to duplicate logic between safe (`visor/`) and unsafe (`ostd/`) layers.
- **Closed-source extensions fragment the project.** VirtualBox's Extension Pack approach (closed-source USB 2/3, RDP, etc.) created an ongoing community frustration and limits who can ship full-featured VirtualBox. Astervisor should avoid this pattern entirely — keep the project open or proprietary in full, not split.
- **Desktop concerns are not server concerns.** VirtualBox's GUI, snapshots, Guest Additions, USB pass-through all take engineering effort that doesn't apply to server workloads. Knowing what Astervisor is *for* — and saying no to feature requests outside that — is critical. (This is the same lesson Firecracker's design illustrates positively.)

### Positive lessons

- **The Main API + multiple frontends pattern is solid.** VirtualBox's "one API surface, many frontends (GUI, CLI, web, scripting)" is structurally good. The user-facing tool is decoupled from the underlying engine via a programmable interface. Astervisor's domain-control plane should be similarly multi-frontend: a typed Rust API that a CLI, a GUI, a programmatic tool, or a Kubernetes-style operator can all consume.
- **PDM as a device framework is informative for *what's enough*.** VirtualBox's PDM is simpler than QEMU's qdev (no QOM, no full reflection) and is sufficient for its needs. Astervisor doesn't need QEMU-grade device abstractions; a PDM-shaped lightweight framework (devices + drivers + buses, minimal reflection) would be in the right size class.
- **Cross-platform was the killer feature for desktop.** VirtualBox owns the desktop Type-2 market largely because users can install it on whatever host OS they have. The lesson for Astervisor is *not* to be cross-platform, but to identify what its analogous "killer property" is and make sure it's deeply baked in, not bolted on. (For Astervisor, that property is presumably "small TCB with language-checked isolation".)
- **Guest paravirt is high-leverage when the guest cooperates.** Guest Additions transform the VirtualBox guest experience from "unmodified but slow" to "deeply integrated and fast". The pattern — *cooperating guests get a much better experience* — maps directly to Astervisor's "cooperating Rust domains" model. Both are betting on the same thing: that workloads willing to cooperate are the high-value workloads, and that catering to them with good paravirt mechanisms pays off.

## What this teaches that other notes don't

VirtualBox teaches a path none of the other Type-2 hypervisors in the survey took: **own the entire stack, including the kernel module, for portability**. KVM is a Linux feature; Firecracker is Linux-only; Kata is Linux-only; QEMU has portability for the userspace VMM but uses KVM as the Linux accelerator. VirtualBox is unique in saying "we'll write our own kernel-side code for every host OS family, in exchange for true cross-platform support".

The lesson is the cost-shape: **portability as a top priority means paying for it in every component**. VirtualBox's userspace VMM, kernel module, build system, frontends, even the IPC layer (XPCOM/COM) all reflect the cross-platform commitment. Removing any one of them would break the property. Compare to Astervisor's design space: portability across host OSes is *not* a goal (Asterinas is the target), so the equivalent costs can be avoided entirely.

A second lesson, more specific: **the difference between server-VMM and desktop-VMM workload classes is large and architecturally legible**. QEMU/Firecracker/Kata are server-VMMs (their concerns are throughput, density, multi-tenancy). VirtualBox is a desktop-VMM (its concerns are GUI, snapshots, USB pass-through, Guest Additions). The same hypervisor primitives (VT-x, EPT, virtio) are used by both, but the surrounding code is shaped by the workload. Astervisor will face the same forcing function: its surrounding code should be shaped by its intended workload (cooperating Rust domains), not by a generic "what does a VMM need" template.

Together with [QEMU](/virtualization/systems/qemu/) (universal server VMM), [Firecracker](/virtualization/systems/firecracker/) (minimal server VMM), [Kata](/virtualization/systems/kata/) (container-VM orchestrator), and [gVisor](/virtualization/systems/gvisor/) (userspace kernel reimpl), this note completes the picture of how Type-2-ish hypervisors arrange themselves around their workload class. VirtualBox is the desktop point; the others are server points; the architectural lessons travel even though the workload concerns don't.
