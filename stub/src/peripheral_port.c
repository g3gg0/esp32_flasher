/* ESP-IDF 6.1 target LL headers supply the silicon differences. All protocol,
 * transfer planning, bounds, recovery, and LEDC timer ownership are shared. */
#include "peripheral_port.h"
#include "protocol.h"
#include "platform.h"
#include "sdkconfig.h"
#include "soc/soc.h"
#include "soc/gpio_reg.h"
#include "soc/soc_caps.h"
#include "soc/spi_periph.h"
#include "hal/i2c_ll.h"
#include "hal/i2c_periph.h"
#include "hal/spi_ll.h"
#include "hal/ledc_ll.h"
#include "hal/ledc_periph.h"
#include "hal/clk_tree_ll.h"
#ifndef GPIO_FUNC0_IN_SEL_CFG_REG
#define GPIO_FUNC0_IN_SEL_CFG_REG (GPIO_FUNC1_IN_SEL_CFG_REG - 4)
#endif

/* Startup disables interrupts and leaves the second CPU parked in ROM. */
enum { __DECLARE_RCC_ATOMIC_ENV = 1 };
#if !CONFIG_IDF_TARGET_ESP32 && !CONFIG_IDF_TARGET_ESP32S2
static inline uint32_t xtal_hz(void) {
#if CONFIG_IDF_TARGET_ESP32P4 || CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C5 || CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32C61 || CONFIG_IDF_TARGET_ESP32S3
    /* These targets only support 40 MHz. ROM download need not populate
     * RTC_XTAL_FREQ_REG: do not depend on a normal IDF boot having run. */
    return 40000000u;
#elif CONFIG_IDF_TARGET_ESP32H2
    return 32000000u;
#else
    return clk_ll_xtal_load_freq_mhz() * 1000000u;
#endif
}
#elif CONFIG_IDF_TARGET_ESP32S2
static inline uint32_t xtal_hz(void) { return CLK_LL_XTAL_FREQ_MHZ * 1000000u; }
#endif
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
static uint32_t apb_hz(void) {
    uint32_t hz = clk_ll_apb_load_freq_hz();
    if (hz < 1000000 || hz > 80000000) { hz = platform_ticks_per_us(); if (hz > 80) hz = 80; hz *= 1000000; }
    return hz;
}
#define I2C_SOURCE I2C_CLK_SRC_APB
#define SPI_SOURCE SPI_CLK_SRC_APB
uint32_t hw_i2c_clock(void) { return apb_hz(); }
uint32_t hw_spi_clock(void) { return apb_hz(); }
#else
#define I2C_SOURCE I2C_CLK_SRC_XTAL
#define SPI_SOURCE SPI_CLK_SRC_XTAL
uint32_t hw_i2c_clock(void) { return xtal_hz(); }
uint32_t hw_spi_clock(void) { return xtal_hz(); }
#endif
unsigned hw_i2c_count(void) { return SOC_HP_I2C_NUM; }
unsigned hw_i2c_fifo(void) { return SOC_I2C_FIFO_LEN; }
void hw_i2c_info(unsigned port, uint32_t v[8]) {
    const i2c_signal_conn_t *s = &i2c_periph_signal[port];
    v[0] = s->sda_out_sig; v[1] = s->sda_in_sig; v[2] = s->scl_out_sig; v[3] = s->scl_in_sig;
    v[4] = GPIO_FUNC0_IN_SEL_CFG_REG; v[5] = SOC_I2C_FIFO_LEN; v[6] = SOC_HP_I2C_NUM; v[7] = 0;
}
void hw_i2c_config(unsigned port, unsigned speed) {
    i2c_ll_enable_bus_clock(port, true); i2c_ll_reset_register(port);
    (void)port; i2c_dev_t *hw = I2C_LL_GET_HW(port);
    i2c_ll_enable_controller_clock(hw, true);
    i2c_ll_set_source_clk(hw, I2C_SOURCE);
    i2c_ll_set_mode(hw, I2C_BUS_MODE_MASTER);
    i2c_ll_enable_pins_open_drain(hw, true); i2c_ll_enable_arbitration(hw, false);
    i2c_ll_master_rx_full_ack_level(hw, false);
    i2c_ll_set_data_mode(hw, I2C_DATA_MODE_MSB_FIRST, I2C_DATA_MODE_MSB_FIRST);
    i2c_ll_enable_fifo_mode(hw, true);
    i2c_ll_disable_intr_mask(hw, 0xffffffff); i2c_ll_clear_intr_mask(hw, 0xffffffff);
    i2c_hal_clk_config_t timing = {0};
    i2c_ll_master_cal_bus_clk(hw_i2c_clock(), speed, &timing);
    i2c_ll_master_set_bus_timing(hw, &timing);
    i2c_ll_master_set_filter(hw, 7);
    i2c_ll_set_tout(hw, i2c_ll_calculate_timeout_us_to_reg_val(hw_i2c_clock(), 25000));
    i2c_ll_txfifo_rst(hw); i2c_ll_rxfifo_rst(hw); i2c_ll_update(hw);
}
void hw_i2c_release(unsigned port) {
    (void)port; i2c_dev_t *hw = I2C_LL_GET_HW(port);
    i2c_ll_disable_intr_mask(hw, 0xffffffff); i2c_ll_reset_register(port);
    i2c_ll_enable_controller_clock(hw, false); i2c_ll_enable_bus_clock(port, false);
}
bool hw_i2c_idle(unsigned port) { (void)port; return !i2c_ll_is_bus_busy(I2C_LL_GET_HW(port)); }
void hw_i2c_begin(unsigned port, const io_i2c_cmd_t *cmds, unsigned count, const uint8_t *tx, unsigned tx_len) {
    (void)port; i2c_dev_t *hw = I2C_LL_GET_HW(port);
    static const uint8_t opcode[] = { I2C_LL_CMD_RESTART, I2C_LL_CMD_WRITE, I2C_LL_CMD_READ, I2C_LL_CMD_STOP, I2C_LL_CMD_END };
    i2c_ll_txfifo_rst(hw); i2c_ll_rxfifo_rst(hw); i2c_ll_clear_intr_mask(hw, 0xffffffff);
    for (unsigned i = 0; i < SOC_I2C_CMD_REG_NUM; ++i) {
        io_i2c_cmd_t cmd = i < count ? cmds[i] : (io_i2c_cmd_t){ IO_END, 0, 0, 0 };
        i2c_ll_hw_cmd_t value = { .op_code = opcode[cmd.op], .byte_num = cmd.count, .ack_en = cmd.ack_check, .ack_val = cmd.nack };
        i2c_ll_master_write_cmd_reg(hw, value, i);
    }
    if (tx_len) i2c_ll_write_txfifo(hw, tx, tx_len);
    i2c_ll_update(hw); i2c_ll_start_trans(hw);
}
int hw_i2c_poll(unsigned port, unsigned last) {
    (void)port; i2c_dev_t *hw = I2C_LL_GET_HW(port); uint32_t raw;
    raw = hw->int_raw.val;
#ifdef I2C_NACK_INT_RAW_M
    if (raw & I2C_NACK_INT_RAW_M) return -RPC_PERIPHERALERRORS_NACK;
#else
    if (raw & I2C_ACK_ERR_INT_RAW_M) return -RPC_PERIPHERALERRORS_NACK;
#endif
    if (raw & I2C_ARBITRATION_LOST_INT_RAW_M) return -RPC_PERIPHERALERRORS_ARBITRATION;
    uint32_t timeout = I2C_TIME_OUT_INT_RAW_M;
#ifdef I2C_SCL_ST_TO_INT_RAW_M
    timeout |= I2C_SCL_ST_TO_INT_RAW_M | I2C_SCL_MAIN_ST_TO_INT_RAW_M;
#endif
    if (raw & timeout) return -RPC_PERIPHERALERRORS_TIMEOUT;
    return (raw & I2C_TRANS_COMPLETE_INT_RAW_M) && i2c_ll_master_is_cmd_done(hw, last) ? 1 : 0;
}
unsigned hw_i2c_read(unsigned port, uint8_t *data, unsigned size) {
    (void)port; i2c_dev_t *hw = I2C_LL_GET_HW(port); uint32_t count;
    i2c_ll_get_rxfifo_cnt(hw, &count);
    if (count != size) return count;
    if (count) i2c_ll_read_rxfifo(hw, data, count);
    return count;
}
unsigned hw_spi_count(void) { return SOC_SPI_PERIPH_NUM - 1; }
void hw_spi_info(unsigned port, uint32_t v[8]) {
    const spi_signal_conn_t *s = &spi_periph_signal[port];
    v[0] = s->spiclk_out; v[1] = s->spid_out; v[2] = s->spiq_in; v[3] = s->spics_out[0];
    v[4] = GPIO_FUNC0_IN_SEL_CFG_REG; v[5] = hw_spi_count(); v[6] = 64; v[7] = 0;
}
uint32_t hw_spi_config(unsigned port, unsigned hz, unsigned mode, bool lsb) {
    spi_ll_enable_bus_clock(port, true); spi_ll_reset_register(port); spi_ll_enable_clock(port, true);
    spi_dev_t *hw = SPI_LL_GET_HW(port);
    spi_ll_master_init(hw); spi_ll_set_clk_source(hw, SPI_SOURCE);
    spi_ll_set_half_duplex(hw, false); spi_ll_master_set_mode(hw, mode);
    spi_ll_set_tx_lsbfirst(hw, lsb); spi_ll_set_rx_lsbfirst(hw, lsb);
    spi_ll_set_command_bitlen(hw, 0); spi_ll_set_addr_bitlen(hw, 0); spi_ll_set_dummy(hw, 0);
    spi_ll_enable_mosi(hw, true); spi_ll_enable_miso(hw, true);
    spi_ll_master_select_cs(hw, 0); spi_ll_master_keep_cs(hw, false);
    spi_ll_master_set_cs_setup(hw, 1); spi_ll_master_set_cs_hold(hw, 1);
    return spi_ll_master_set_clock(hw, hw_spi_clock(), hz, 128);
}
void hw_spi_release(unsigned port) {
    spi_ll_master_select_cs(SPI_LL_GET_HW(port), -1);
    spi_ll_reset_register(port); spi_ll_enable_clock(port, false); spi_ll_enable_bus_clock(port, false);
}
bool hw_spi_begin(unsigned port, const uint8_t *data, unsigned size, unsigned timeout_us) {
    spi_dev_t *hw = SPI_LL_GET_HW(port);
    spi_ll_set_mosi_bitlen(hw, size * 8); spi_ll_set_miso_bitlen(hw, size * 8);
    spi_ll_write_buffer(hw, data, size * 8);
#if !CONFIG_IDF_TARGET_ESP32 && !CONFIG_IDF_TARGET_ESP32S2
    uint32_t start = platform_cycles(), budget = timeout_us * platform_ticks_per_us();
    hw->cmd.update = 1;
    while (hw->cmd.update) if ((uint32_t)(platform_cycles() - start) >= budget) return false;
#else
    (void)timeout_us;
#endif
    spi_ll_user_start(hw); return true;
}
bool hw_spi_done(unsigned port) { return spi_ll_usr_is_done(SPI_LL_GET_HW(port)); }
void hw_spi_read(unsigned port, uint8_t *data, unsigned size) { spi_ll_read_buffer(SPI_LL_GET_HW(port), data, size * 8); }
unsigned hw_pwm_count(void) { return SOC_LEDC_CHANNEL_NUM; }
unsigned hw_pwm_timers(void) { return SOC_LEDC_TIMER_NUM; }
unsigned hw_pwm_max_bits(void) { return SOC_LEDC_TIMER_BIT_WIDTH - 1; }
uint32_t hw_pwm_clock(void) {
#if SOC_LEDC_SUPPORT_XTAL_CLOCK
    return xtal_hz();
#else
    return apb_hz();
#endif
}
void hw_pwm_info(unsigned channel, uint32_t v[8]) {
    v[0] = ledc_periph_signal[LEDC_LOW_SPEED_MODE].sig_out0_idx + channel;
    v[1] = hw_pwm_count(); v[2] = hw_pwm_timers(); v[3] = hw_pwm_max_bits(); v[4] = 0x3ffff;
    v[5] = v[6] = v[7] = 0;
}
bool hw_pwm_ready(unsigned channel) {
#if CONFIG_IDF_TARGET_ESP32
    return !LEDC.channel_group[LEDC_LOW_SPEED_MODE].channel[channel].conf1.duty_start;
#else
    (void)channel; return true;
#endif
}
void hw_pwm_update(unsigned channel, unsigned duty) {
    ledc_ll_set_duty_int_part(&LEDC, LEDC_LOW_SPEED_MODE, channel, duty);
#if SOC_LEDC_GAMMA_CURVE_FADE_SUPPORTED
#if CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32H2
    ledc_ll_set_duty_range_wr_addr(&LEDC, LEDC_LOW_SPEED_MODE, channel, 0);
#endif
    ledc_ll_set_fade_param_range(&LEDC, LEDC_LOW_SPEED_MODE, channel, 0, 1, 1, 0, 1);
    ledc_ll_set_range_number(&LEDC, LEDC_LOW_SPEED_MODE, channel, 1);
#else
    ledc_ll_set_fade_param(&LEDC, LEDC_LOW_SPEED_MODE, channel, 1, 1, 0, 1);
#endif
    ledc_ll_set_duty_start(&LEDC, LEDC_LOW_SPEED_MODE, channel);
    ledc_ll_ls_channel_update(&LEDC, LEDC_LOW_SPEED_MODE, channel);
}
void hw_pwm_config(unsigned channel, unsigned timer, unsigned divider, unsigned bits, unsigned duty, bool reset_timer, bool first) {
    if (first) {
        ledc_ll_enable_bus_clock(true); ledc_ll_enable_reset_reg(true); ledc_ll_enable_reset_reg(false);
        ledc_ll_enable_clock(&LEDC, true);
#if SOC_LEDC_SUPPORT_XTAL_CLOCK
        ledc_ll_set_slow_clk_sel(&LEDC, LEDC_SLOW_CLK_XTAL);
#else
        ledc_ll_set_slow_clk_sel(&LEDC, LEDC_SLOW_CLK_APB);
#endif
    }
    if (reset_timer) {
        ledc_ll_enable_timer_power(&LEDC, LEDC_LOW_SPEED_MODE, timer, true);
#if SOC_LEDC_HAS_TIMER_SPECIFIC_MUX
        ledc_ll_set_clock_source(&LEDC, LEDC_LOW_SPEED_MODE, timer, LEDC_SCLK);
#endif
        ledc_ll_set_clock_divider(&LEDC, LEDC_LOW_SPEED_MODE, timer, divider);
        ledc_ll_set_duty_resolution(&LEDC, LEDC_LOW_SPEED_MODE, timer, bits);
        ledc_ll_timer_rst(&LEDC, LEDC_LOW_SPEED_MODE, timer);
        ledc_ll_timer_resume(&LEDC, LEDC_LOW_SPEED_MODE, timer);
        ledc_ll_ls_timer_update(&LEDC, LEDC_LOW_SPEED_MODE, timer);
    }
    ledc_ll_bind_channel_timer(&LEDC, LEDC_LOW_SPEED_MODE, channel, timer);
    ledc_ll_set_hpoint(&LEDC, LEDC_LOW_SPEED_MODE, channel, 0);
    ledc_ll_set_idle_level(&LEDC, LEDC_LOW_SPEED_MODE, channel, 0);
    hw_pwm_update(channel, duty);
    ledc_ll_set_sig_out_en(&LEDC, LEDC_LOW_SPEED_MODE, channel, true);
    ledc_ll_ls_channel_update(&LEDC, LEDC_LOW_SPEED_MODE, channel);
}
void hw_pwm_release(unsigned channel, unsigned timer, bool last_timer, bool last) {
    ledc_ll_set_sig_out_en(&LEDC, LEDC_LOW_SPEED_MODE, channel, false);
    ledc_ll_ls_channel_update(&LEDC, LEDC_LOW_SPEED_MODE, channel);
    if (last_timer) { ledc_ll_timer_pause(&LEDC, LEDC_LOW_SPEED_MODE, timer); ledc_ll_enable_timer_power(&LEDC, LEDC_LOW_SPEED_MODE, timer, false); }
    if (last) { ledc_ll_enable_clock(&LEDC, false); ledc_ll_enable_bus_clock(false); }
}
