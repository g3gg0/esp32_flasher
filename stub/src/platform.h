#pragma once
#include <stdint.h>
void platform_init(void);
int platform_rx(uint8_t *byte);
void platform_tx(uint8_t byte);
void platform_flush(void);
void platform_identity(void *packet);
void platform_delay(uint32_t us);
uint32_t platform_cycles(void);
uint32_t platform_ticks_per_us(void);
int platform_register_allowed(uint32_t address, int write);
void platform_prepare_register_write(uint32_t address, uint32_t value, uint32_t mask);
