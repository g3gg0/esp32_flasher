#include "platform.h"
#include "protocol.h"
#include "esp_rom_serial_output.h"
#include "esp_rom_sys.h"
#include "soc/soc.h"
#include "soc/efuse_reg.h"
#include "soc/soc_caps.h"
#include "soc/uart_reg.h"
#if CONFIG_IDF_TARGET_ESP32C6
#include "hal/clk_tree_ll.h"
#endif
#if defined(__riscv)
#include "riscv/rv_utils.h"
#endif
#if __has_include("soc/rtc_cntl_reg.h")
#include "soc/rtc_cntl_reg.h"
#endif
#if __has_include("soc/lp_wdt_reg.h")
#include "soc/lp_wdt_reg.h"
#endif
#include STUB_UART_HEADER

static uint8_t serial_port;

static void copy_string(char *dest, const char *source, unsigned size) {
    for (unsigned i = 0; i < size; ++i) {
        dest[i] = *source;
        if (*source) ++source;
    }
}

void platform_init(void) {
#if CONFIG_IDF_TARGET_ESP32C6
    /* Inherited ROM frequency bookkeeping must match the actual CPU divider
     * for delay_us and cycle timestamps. Keep fractional MHz in cpu_hz(). */
    esp_rom_set_cpu_ticks_per_us((platform_cpu_hz()+500000u)/1000000u);
#endif
    ets_set_user_start(0);
    serial_port = GetUartDevice()->buff_uart_no;
    /* Download RX and console TX can select different channels after ROM SYNC. */
#if !CONFIG_IDF_TARGET_ESP32C3
    esp_rom_output_set_as_console(serial_port);
#endif
    /* C3 has no stable ROM console-switch entry; keep its inherited routing. */
    /* ROM download can leave the RTC watchdog armed (notably USB-JTAG). */
#ifdef RTC_CNTL_WDTWPROTECT_REG
    REG_WRITE(RTC_CNTL_WDTWPROTECT_REG, 0x50d83aa1);
    REG_WRITE(RTC_CNTL_WDTCONFIG0_REG, 0);
    REG_WRITE(RTC_CNTL_WDTWPROTECT_REG, 0);
#endif
#ifdef RTC_CNTL_SWD_WPROTECT_REG
    REG_WRITE(RTC_CNTL_SWD_WPROTECT_REG, 0x8f1d312a);
    REG_SET_BIT(RTC_CNTL_SWD_CONF_REG, RTC_CNTL_SWD_AUTO_FEED_EN);
    REG_WRITE(RTC_CNTL_SWD_WPROTECT_REG, 0);
#endif
#ifdef LP_WDT_WPROTECT_REG
    REG_WRITE(LP_WDT_WPROTECT_REG, 0x50d83aa1);
    REG_WRITE(LP_WDT_CONFIG0_REG, 0);
    REG_WRITE(LP_WDT_WPROTECT_REG, 0);
#endif
#ifdef LP_WDT_SWD_WPROTECT_REG
    REG_WRITE(LP_WDT_SWD_WPROTECT_REG, 0x50d83aa1);
    REG_SET_BIT(LP_WDT_SWD_CONFIG_REG, LP_WDT_SWD_AUTO_FEED_EN);
    REG_WRITE(LP_WDT_SWD_WPROTECT_REG, 0);
#endif
}

int platform_rx(uint8_t *byte) { return esp_rom_output_rx_one_char(byte); }
void platform_tx(uint8_t byte) {
    /* Native USB OTG can report a full software FIFO. Its ROM routine polls
       USB events; retry instead of silently dropping a binary protocol byte. */
    while (esp_rom_output_tx_one_char(byte)) esp_rom_delay_us(1);
}
void platform_flush(void) { esp_rom_output_flush_tx(serial_port); }
void platform_delay(uint32_t us) { esp_rom_delay_us(us); }
uint32_t platform_ticks_per_us(void) { return esp_rom_get_cpu_ticks_per_us(); }
uint32_t platform_cpu_hz(void) {
#if CONFIG_IDF_TARGET_ESP32C6
    if(clk_ll_cpu_get_src()==SOC_CPU_CLK_SRC_PLL)
        return clk_ll_bbpll_get_freq_mhz()*1000000u/clk_ll_cpu_get_hs_divider();
    if(clk_ll_cpu_get_src()==SOC_CPU_CLK_SRC_XTAL)
        return 40000000u/clk_ll_cpu_get_ls_divider();
#endif
    return platform_ticks_per_us()*1000000u;
}
uint32_t platform_cycles(void) {
    uint32_t cycles;
#if defined(__riscv)
    cycles = rv_utils_get_cycle_count();
#else
    __asm__ volatile("rsr.ccount %0" : "=a"(cycles));
#endif
    return cycles;
}

int platform_register_allowed(uint32_t address, int write) {
    (void) write;
    /* Same peripheral register surface needed by the existing GPIO/ADC layer.
       RAM, code, flash and unaligned addresses are deliberately excluded. */
    return !(address & 3) && address >= STUB_REG_START && address < STUB_REG_END;
}

void platform_identity(void *packet) {
    rpc_identity_t *id = packet;
#if defined(EFUSE_RD_MAC_SPI_SYS_0_REG) && defined(EFUSE_RD_MAC_SPI_SYS_1_REG)
    uint32_t lo = REG_READ(EFUSE_RD_MAC_SPI_SYS_0_REG);
    uint32_t hi = REG_READ(EFUSE_RD_MAC_SPI_SYS_1_REG);
#elif defined(EFUSE_RD_MAC_SYS_0_REG) && defined(EFUSE_RD_MAC_SYS_1_REG)
    uint32_t lo = REG_READ(EFUSE_RD_MAC_SYS_0_REG);
    uint32_t hi = REG_READ(EFUSE_RD_MAC_SYS_1_REG);
#elif defined(EFUSE_BLK0_RDATA1_REG) && defined(EFUSE_BLK0_RDATA2_REG)
    uint32_t lo = REG_READ(EFUSE_BLK0_RDATA1_REG);
    uint32_t hi = REG_READ(EFUSE_BLK0_RDATA2_REG);
#else
    uint32_t lo = 0, hi = 0;
#endif
    id->mac[0] = hi >> 8; id->mac[1] = hi;
    id->mac[2] = lo >> 24; id->mac[3] = lo >> 16;
    id->mac[4] = lo >> 8; id->mac[5] = lo;
    if (lo || (hi & 0xffff)) id->flags |= RPC_IDENTITYFLAGS_MAC_VALID;
    id->cpu_cores = STUB_CORES;
    id->transport = serial_port;
    id->reset_reason = esp_rom_get_reset_reason(0);
    copy_string(id->chip, STUB_CHIP, sizeof(id->chip));
    copy_string(id->cpu, STUB_CPU, sizeof(id->cpu));
    copy_string(id->build, RPC_BUILD_VERSION, sizeof(id->build));
    copy_string(id->idf, STUB_IDF, sizeof(id->idf));
    /* No flash is required or touched. flash_jedec_id remains unknown (0),
       FLASH_ID_VALID stays clear, so absence is never inferred from no probe. */
}
