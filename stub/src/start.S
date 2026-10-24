#if defined(__riscv)
    .section .entry,"ax",@progbits
    .global _start
_start:
    csrci mstatus, 8
    .option push
    .option norelax
    la gp, __global_pointer$
    la sp, _stack_top
    .option pop
    call stub_main
1:  j 1b
#else
    .section .entry,"ax",@progbits
    .global _start
    .align 4
_start:
    rsil a2, 15
    movi a1, _stack_top
    movi a0, 0
    call4 stub_main
1:  j 1b
#endif
