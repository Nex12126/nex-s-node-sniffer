# Nex's Node Sniffer

A lightweight, local-first runtime activity inspector and forensics utility for Node.js environments.

Nex's Node Sniffer monitors, hooks, and logs local execution metrics, filesystem operations, child process spawns, and network requests executed by Node.js scripts in real time without sending data upstream.

---

## Overview

Modern Node.js packages and dependencies often pull in deeply nested third-party modules. **Nex's Node Sniffer** acts as an isolated audit layer between the host runtime and running scripts, allowing developers and forensic researchers to inspect internal activity, unmask malicious build-time behavior, and analyze script execution safely.

---

## Features

* **Process & Child Spawn Tracking**: Monitors process trees and alerts on unexpected CLI invocations (`exec`, `spawn`, `fork`).
* **I/O & Filesystem Auditing**: Records read, write, and deletion events across system and sensitive user directories.
* **Network & Socket Inspection**: Hooks into HTTP/HTTPS, DNS resolutions, and raw TCP/UDP socket calls initiated by running scripts.
* **Telemetry & Package Behavior Profiling**: Identifies stealthy outbound traffic, obfuscated scripts, and environment variable dumps.
* **Local-First & Zero Telemetry**: Operates entirely offline. Collected audit logs stay exclusively on your local workstation.

---

## Architecture & Requirements

* **Architecture**: Standalone Windows GUI installer (x86/x64).
* **Target Runtime**: Node.js v18.x or later.
* **Platform**: Windows 10 / 11 / Server.

---

## Installation & Setup

1. Download the latest installer (`Nex's Node Sniffer.exe`) from the [Releases](https://github.com/...) section.
2. Run the installer and complete the setup wizard.
3. Launch `Nex's Node Sniffer` and attach it to a running Node process or launch a target script directly via the inspector workbench.

---

## Security & Intended Use

### Intended Use
This utility is designed strictly for local debugging, defensive IT security auditing, and forensic analysis of untrusted scripts and dependencies.

### Disclaimer
* This tool provides observability and auditing heuristics; it is not a kernel-level virtualization barrier.
* Always analyze untrusted or suspected malicious scripts inside an isolated virtual machine or sandbox environment.
