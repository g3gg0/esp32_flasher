#pragma once
#include <stdint.h>
/* Return zero on success, a ROM result otherwise. All buffers are aligned. */
unsigned hw_flash_probe(uint32_t *id, uint32_t *size, uint32_t *status);
unsigned hw_flash_read(uint32_t address, uint32_t *data, unsigned length);
unsigned hw_flash_write(uint32_t address, const uint32_t *data, unsigned length);
unsigned hw_flash_erase(uint32_t address);
