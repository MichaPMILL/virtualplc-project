# virtualplc-project 🏭

**A lightweight, educational Structured Text (SCL / IEC 61131-3) Parser & Interpreter written in pure PHP.**

This project demonstrates how to build a language core for industrial automation logic. It parses SCL (Structured Control Language) code into an Abstract Syntax Tree (AST) and executes it within a PHP environment, complete with simulated hardware bindings (Modbus/IO).

> **Note:** This project is for **educational purposes** only. It is designed to teach compiler theory (Lexing/Parsing/Interpreting) in the context of OT (Operational Technology). Do not use for safety-critical industrial control.

## ✨ Features

* **Recursive Descent Parser:** Handles complex nested structures.
* **Operator Precedence:** Correctly evaluates logic (`AND` > `OR`), comparisons, and math.
* **Control Flow:** Supports `IF / ELSE IF / ELSE`, `WHILE`, and `FOR` loops.
* **Custom Blocks:** Define and call custom subroutines (`BLOCK name ... END_BLOCK`).
* **Hardware Abstraction:** Hooks for reading/writing to external hardware (e.g., Modbus memory maps).
* **Data Types:** Strong typing for `INT` and `BOOL`.
* **Modbus TCP:** You can use Modbus I/O Modules such as WaveShare modules.

## 🚀 Quick Start

### 1. Installation

Simply clone the repo or copy the `SCLCore.php` file into your project.

```bash
git clone https://github.com/yourusername/php-scl-core.git](https://github.com/MichaPMILL/virtualplc-project

```
Then with your favorite webserver, exploit the index.php. 

### 2. Launch

Simply use the following command :
```bash
php daemon.php
```

## Control Flow

**If / Elsif / Else:**

```iecst
IF InputA = TRUE AND InputA = TRUE THEN
    Alarm := TRUE;
ELSE IF InputC = FALSE THEN
    Warning := TRUE;
ELSE
    Status := 1;
END_IF;

```

**Loops:**

```iecst
WHILE Running = TRUE DO
    Count := Count + 1;
END_WHILE;

FOR I := 1 TO 10 DO
    Total := Total + I;
END_FOR;

```

**Example Code**
The example code provided is in project.scl and project.json. You can import the JSON directly on the Web interfae.


## 🧠 Architecture

The core logic is split into three classes within `SCLCore.php`:

1. **`Lexer`**: Scans the input string and converts it into a stream of tokens (`T_IF`, `T_ID`, `T_INT`, etc.).
2. **`Parser`**: Consumes tokens to build an **Abstract Syntax Tree (AST)**.
3. **`Interpreter`**: Traverses the AST recursively. It maintains a memory array for variables and executes the logic node by node.

## 🔌 Hardware Hooks

You can hook the interpreter to real-world I/O (like a Modbus Server) using the hardware handler:

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

## 📄 License
BSD3 License
