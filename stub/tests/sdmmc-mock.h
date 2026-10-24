#pragma once
#include <stdint.h>
#define SD_REG_BASE 0
#include "sdmmc_regs.h"
uint32_t sd_mock_read(uint32_t reg);
void sd_mock_write(uint32_t reg, uint32_t value);
uint32_t sd_mock_address(void *ptr);
#define SD_READ(reg) sd_mock_read(reg)
#define SD_WRITE(reg, value) sd_mock_write(reg, value)
#define SD_UNCACHED(ptr) ((void *)(ptr))
#define SD_DMA_ADDRESS(ptr) sd_mock_address(ptr)
#define SD_BARRIER() __asm__ volatile("" ::: "memory")
