/* USB pad ownership belongs to the target, not the browser register recipes. */
#include "platform.h"
#include "sdkconfig.h"
#include "soc/soc.h"
#include "soc/soc_caps.h"
#if SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_IDF_TARGET_ESP32S2
#include "soc/io_mux_reg.h"
#define GPIO_MUX(pin) (IO_MUX_GPIO0_REG + (pin) * 4)
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

void platform_prepare_register_write(uint32_t address, uint32_t value, uint32_t mask) {
#if SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_IDF_TARGET_ESP32S2
    /* Only explicit GPIO-function selection takes ownership. Merely loading
       the stub, observing a pad or changing other mux fields preserves USB. */
    if ((mask & MCU_SEL_M) != MCU_SEL_M ||
        ((value & MCU_SEL_M) >> MCU_SEL_S) != PIN_FUNC_GPIO) return;
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    if (address == GPIO_MUX(USB_INT_PHY0_DM_GPIO_NUM) ||
        address == GPIO_MUX(USB_INT_PHY0_DP_GPIO_NUM)) {
        uint32_t pulls = address == GPIO_MUX(USB_INT_PHY0_DM_GPIO_NUM)
            ? USB_SERIAL_JTAG_DM_PULLUP | USB_SERIAL_JTAG_DM_PULLDOWN
            : USB_SERIAL_JTAG_DP_PULLUP | USB_SERIAL_JTAG_DP_PULLDOWN;
        REG_WRITE(USB_SERIAL_JTAG_CONF0_REG,
                  (REG_READ(USB_SERIAL_JTAG_CONF0_REG) &
                   ~(USB_SERIAL_JTAG_USB_PAD_ENABLE | pulls)) |
                  USB_SERIAL_JTAG_PAD_PULL_OVERRIDE);
    }
#endif
#if CONFIG_IDF_TARGET_ESP32P4
    /* As in IDF gpio_ll_func_sel: default PHY0 -> USJ, PHY1 -> USB OTG. */
    if (address == GPIO_MUX(USB_OTG_INT_PHY_DM_GPIO_NUM) ||
        address == GPIO_MUX(USB_OTG_INT_PHY_DP_GPIO_NUM)) {
        uint32_t pulls = address == GPIO_MUX(USB_OTG_INT_PHY_DM_GPIO_NUM)
            ? USB_WRAP_DM_PULLUP | USB_WRAP_DM_PULLDOWN
            : USB_WRAP_DP_PULLUP | USB_WRAP_DP_PULLDOWN;
        REG_WRITE(USB_WRAP_OTG_CONF_REG,
                  (REG_READ(USB_WRAP_OTG_CONF_REG) & ~(USB_WRAP_USB_PAD_ENABLE | pulls)) |
                  USB_WRAP_PAD_PULL_OVERRIDE);
    }
#endif
#if CONFIG_IDF_TARGET_ESP32S2
    /* S2 has OTG only; its RTC controller can override USB pad ownership. */
    if (address == GPIO_MUX(USBPHY_DM_NUM) || address == GPIO_MUX(USBPHY_DP_NUM)) {
        uint32_t pulls = address == GPIO_MUX(USBPHY_DM_NUM)
            ? RTC_CNTL_USB_DM_PULLUP | RTC_CNTL_USB_DM_PULLDOWN
            : RTC_CNTL_USB_DP_PULLUP | RTC_CNTL_USB_DP_PULLDOWN;
        REG_WRITE(RTC_CNTL_USB_CONF_REG,
                  (REG_READ(RTC_CNTL_USB_CONF_REG) & ~(RTC_CNTL_USB_PAD_ENABLE | pulls)) |
                  RTC_CNTL_USB_PAD_ENABLE_OVERRIDE | RTC_CNTL_USB_PAD_PULL_OVERRIDE);
    }
#endif
#else
    (void)address; (void)value; (void)mask;
#endif
}
