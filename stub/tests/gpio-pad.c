/* Run the real target-specific pad hook against mapped peripheral memory. */
#define _GNU_SOURCE
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include "platform.h"
#include "sdkconfig.h"
#include "soc/soc.h"
#include "soc/soc_caps.h"
#if SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_IDF_TARGET_ESP32S2
#include "soc/io_mux_reg.h"
#endif
#if SOC_USB_SERIAL_JTAG_SUPPORTED
#include "soc/usb_serial_jtag_reg.h"
#endif
#if CONFIG_IDF_TARGET_ESP32P4
#include "soc/usb_wrap_reg.h"
#endif
#if CONFIG_IDF_TARGET_ESP32S2
#include "soc/rtc_cntl_reg.h"
#include "soc/usb_pins.h"
#endif

#if SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_IDF_TARGET_ESP32S2
static void exercise(uint32_t conf, unsigned dm, unsigned dp, uint32_t enable,
                     uint32_t override, uint32_t dm_pulls, uint32_t dp_pulls) {
    void *page = (void *)(uintptr_t)(conf & ~4095u);
    assert(mmap(page, 4096, PROT_READ | PROT_WRITE,
                MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == page);
    volatile uint32_t *reg = (void *)(uintptr_t)conf;
    const uint32_t initial = 0xffffffff;
    const unsigned pins[] = {dm, dp};
    const uint32_t pulls[] = {dm_pulls, dp_pulls};
    for (unsigned i = 0; i < 2; ++i) {
        uint32_t mux = IO_MUX_GPIO0_REG + pins[i] * 4;
        *reg = initial;
        /* Pull/drive-only, partial-function and alternate-function writes
           must not take the USB pad away from an active transport. */
        platform_prepare_register_write(mux, 0, FUN_PU);
        platform_prepare_register_write(mux, PIN_FUNC_GPIO << MCU_SEL_S, 1u << MCU_SEL_S);
        platform_prepare_register_write(mux, 0, MCU_SEL_M);
        platform_prepare_register_write(IO_MUX_GPIO0_REG, PIN_FUNC_GPIO << MCU_SEL_S, MCU_SEL_M);
        assert(*reg == initial);
        platform_prepare_register_write(mux, PIN_FUNC_GPIO << MCU_SEL_S, MCU_SEL_M);
        assert(*reg == ((initial & ~(enable | pulls[i])) | override));
        /* The sibling line's pull bits and every unrelated field survive. */
        assert((*reg & pulls[1-i]) == pulls[1-i]);
        uint32_t released = *reg;
        platform_prepare_register_write(mux, PIN_FUNC_GPIO << MCU_SEL_S, MCU_SEL_M);
        assert(*reg == released);
    }
    assert(munmap(page, 4096) == 0);
}
#endif

int main(int argc, char **argv) {
    (void)argc; (void)argv;
#if SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_IDF_TARGET_ESP32S2
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    /* The address comes independently from the generated register inventory. */
    assert(argc >= 2 && USB_SERIAL_JTAG_CONF0_REG == strtoul(argv[1], 0, 0));
    exercise(USB_SERIAL_JTAG_CONF0_REG, USB_INT_PHY0_DM_GPIO_NUM, USB_INT_PHY0_DP_GPIO_NUM,
             USB_SERIAL_JTAG_USB_PAD_ENABLE, USB_SERIAL_JTAG_PAD_PULL_OVERRIDE,
             USB_SERIAL_JTAG_DM_PULLUP | USB_SERIAL_JTAG_DM_PULLDOWN,
             USB_SERIAL_JTAG_DP_PULLUP | USB_SERIAL_JTAG_DP_PULLDOWN);
#endif
#if CONFIG_IDF_TARGET_ESP32P4
    assert(argc >= 3 && USB_WRAP_OTG_CONF_REG == strtoul(argv[2], 0, 0));
    exercise(USB_WRAP_OTG_CONF_REG, USB_OTG_INT_PHY_DM_GPIO_NUM, USB_OTG_INT_PHY_DP_GPIO_NUM,
             USB_WRAP_USB_PAD_ENABLE, USB_WRAP_PAD_PULL_OVERRIDE,
             USB_WRAP_DM_PULLUP | USB_WRAP_DM_PULLDOWN, USB_WRAP_DP_PULLUP | USB_WRAP_DP_PULLDOWN);
#endif
#if CONFIG_IDF_TARGET_ESP32S2
    assert(argc >= 2 && RTC_CNTL_USB_CONF_REG == strtoul(argv[1], 0, 0));
    exercise(RTC_CNTL_USB_CONF_REG, USBPHY_DM_NUM, USBPHY_DP_NUM,
             RTC_CNTL_USB_PAD_ENABLE, RTC_CNTL_USB_PAD_PULL_OVERRIDE | RTC_CNTL_USB_PAD_ENABLE_OVERRIDE,
             RTC_CNTL_USB_DM_PULLUP | RTC_CNTL_USB_DM_PULLDOWN,
             RTC_CNTL_USB_DP_PULLUP | RTC_CNTL_USB_DP_PULLDOWN);
#endif
#else
    /* Targets without USB must never dereference the supplied addresses. */
    platform_prepare_register_write(0x60000000, 0x1000, 0xffffffff);
#endif
    return 0;
}
