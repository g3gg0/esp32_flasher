#pragma once
#ifdef RPC_SDMMC_TEST
#include "sdmmc-mock.h"
#else
#include "soc/soc.h"
#include "soc/sdmmc_reg.h"
#if defined(DR_REG_SDHOST_BASE)
#define SD_REG_BASE DR_REG_SDHOST_BASE
#else
#define SD_REG_BASE DR_REG_SDMMC_BASE
#endif
#include "sdmmc_regs.h"
#if defined(SDHOST_CTRL_REG)
_Static_assert(SD_REG_CTRL == SDHOST_CTRL_REG && SD_REG_TBBCNT == SDHOST_TBBCNT_REG && SD_REG_DBADDR == SDHOST_DBADDR_REG, "P4 DW-MSHC register layout");
#else
_Static_assert(SD_REG_CTRL == SDMMC_CTRL_REG && SD_REG_TBBCNT == SDMMC_TBBCNT_REG && SD_REG_DBADDR == SDMMC_DBADDR_REG, "S3 DW-MSHC register layout");
#endif
#define SD_READ(address) REG_READ(address)
#define SD_WRITE(address, value) REG_WRITE(address, value)
#define SD_DMA_ADDRESS(ptr) ((uint32_t)(uintptr_t)(ptr))
#define SD_UNCACHED(ptr) ((void *)((uintptr_t)(ptr) + STUB_DMA_UNCACHED_OFFSET))
#if defined(__riscv)
#define SD_BARRIER() __asm__ volatile("fence iorw, iorw" ::: "memory")
#else
#define SD_BARRIER() __asm__ volatile("memw" ::: "memory")
#endif
#endif
