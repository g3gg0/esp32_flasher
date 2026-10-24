/* Evaluate the real target LL adapter on mapped fake peripheral registers. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include "../src/peripheral_port.c"
uint32_t platform_cycles(void) { static uint32_t n; return ++n; }
uint32_t platform_ticks_per_us(void) { return 80; }
uint32_t esp_dport_access_reg_read(uint32_t addr) { return *(volatile uint32_t *)(uintptr_t)addr; }
int main(void) {
    if (mmap((void *)0x30000000, 0x40000000, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED|MAP_NORESERVE,-1,0)==MAP_FAILED) return 1;
    hw_i2c_config(0,100000);
    printf("I2C clock %u\n", hw_i2c_clock());
    return 0;
}
