#pragma once
#include <stdint.h>
#define SDHOST_CTRL_REG 0x00
#define SDHOST_CLKENA_REG 0x10
#define SDHOST_BLKSIZ_REG 0x1c
#define SDHOST_BYTCNT_REG 0x20
#define SDHOST_CMDARG_REG 0x28
#define SDHOST_CMD_REG 0x2c
#define SDHOST_RESP0_REG 0x30
#define SDHOST_RESP1_REG 0x34
#define SDHOST_RESP2_REG 0x38
#define SDHOST_RESP3_REG 0x3c
#define SDHOST_RINTSTS_REG 0x44
#define SDHOST_STATUS_REG 0x48
#define SDHOST_FIFOTH_REG 0x4c
#define SDHOST_TBBCNT_REG 0x60
#define SDHOST_BMOD_REG 0x80
#define SDHOST_PLDMND_REG 0x84
#define SDHOST_DBADDR_REG 0x88
#define SDHOST_IDSTS_REG 0x8c
#define SDHOST_IDINTEN_REG 0x90
uint32_t sd_mock_read(uint32_t reg);
void sd_mock_write(uint32_t reg, uint32_t value);
uint32_t sd_mock_address(void *ptr);
#define SD_READ(reg) sd_mock_read(reg)
#define SD_WRITE(reg, value) sd_mock_write(reg, value)
#define SD_UNCACHED(ptr) ((void *)(ptr))
#define SD_DMA_ADDRESS(ptr) sd_mock_address(ptr)
#define SD_BARRIER() __asm__ volatile("" ::: "memory")
