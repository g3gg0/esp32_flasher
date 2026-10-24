/* Hardware boundary only: the firmware's actual dispatcher and SD driver run. */
#include <stdlib.h>
#include <string.h>
#include "sdmmc-mock.h"
static uint32_t regs[64], writes;
static void *pointers[16];
static unsigned pointer_count;
static int mode(const char *value) { const char *selected = getenv("SD_TEST_MODE"); return selected && !strcmp(selected, value); }
uint32_t sd_mock_address(void *ptr) {
    for (unsigned i = 0; i < pointer_count; ++i) if (pointers[i] == ptr) return i + 1;
    pointers[pointer_count++] = ptr; return pointer_count;
}
uint32_t sd_mock_read(uint32_t reg) {
    if (reg == SD_REG_CLKENA) return 2;
    return regs[reg / 4];
}
void sd_mock_write(uint32_t reg, uint32_t value) {
    ++writes;
    if (reg == SD_REG_RINTSTS || reg == SD_REG_IDSTS) {
        if (!(mode("stale") && reg == SD_REG_RINTSTS)) regs[reg / 4] &= ~value;
        else regs[reg / 4] = 4;
        return;
    }
    regs[reg / 4] = value;
    if (reg == SD_REG_CTRL) { regs[reg / 4] &= ~7; return; }
    if (reg == SD_REG_BMOD) { regs[reg / 4] &= ~1; return; }
    if (reg != SD_REG_CMD) return;
    unsigned command = value & 63;
    /* Assert no forbidden writes, and no arbitrary host flags escape validation. */
    if (command == 24 || command == 25 || command == 38 || (value & (1u << 10))) abort();
    if (mode("start")) return;
    regs[reg / 4] &= ~(1u << 31);
    regs[SD_REG_RINTSTS / 4] = mode("response_timeout") ? 256 : mode("response_crc") ? 64 : 4;
    if (mode("no_done")) regs[SD_REG_RINTSTS / 4] = 0;
    regs[SD_REG_RESP0 / 4] = command == 55 ? 32 : command == 8 ? 0x1aa : command == 3 ? 0x12340000 : 0x900;
    if (command != 17) return;
    uint32_t *desc = pointers[regs[SD_REG_DBADDR / 4] - 1];
    uint8_t *data = pointers[desc[2] - 1];
    uint32_t argument = regs[SD_REG_CMDARG / 4];
    for (unsigned i = 0; i < 512; ++i) data[i] = (argument * 17 + i) & 255;
    if (!mode("ownership")) desc[0] &= ~(1u << 31);
    regs[SD_REG_TBBCNT / 4] = mode("short") ? 508 : 512;
    regs[SD_REG_IDSTS / 4] = mode("dma") ? 4 : 2;
    regs[SD_REG_RINTSTS / 4] |= mode("crc") ? 128 : mode("data_timeout") ? 512 : 8;
    if (mode("card_status")) regs[SD_REG_RESP0 / 4] |= 1u << 31;
}
