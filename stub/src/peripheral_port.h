#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct { uint8_t op, count, ack_check, nack; } io_i2c_cmd_t;
enum { IO_START, IO_WRITE, IO_READ, IO_STOP, IO_END };
unsigned hw_i2c_count(void);
unsigned hw_i2c_fifo(void);
void hw_i2c_info(unsigned port, uint32_t values[8]);
uint32_t hw_i2c_clock(void);
void hw_i2c_config(unsigned port, unsigned speed);
void hw_i2c_release(unsigned port);
bool hw_i2c_idle(unsigned port);
void hw_i2c_begin(unsigned port, const io_i2c_cmd_t *cmds, unsigned count, const uint8_t *tx, unsigned tx_len);
int hw_i2c_poll(unsigned port, unsigned last);
unsigned hw_i2c_read(unsigned port, uint8_t *data, unsigned size);
unsigned hw_spi_count(void);
void hw_spi_info(unsigned port, uint32_t values[8]);
uint32_t hw_spi_clock(void);
uint32_t hw_spi_config(unsigned port, unsigned hz, unsigned mode, bool lsb);
void hw_spi_release(unsigned port);
bool hw_spi_begin(unsigned port, const uint8_t *data, unsigned size, unsigned timeout_us);
bool hw_spi_done(unsigned port);
void hw_spi_read(unsigned port, uint8_t *data, unsigned size);
unsigned hw_pwm_count(void);
unsigned hw_pwm_timers(void);
unsigned hw_pwm_max_bits(void);
uint32_t hw_pwm_clock(void);
void hw_pwm_info(unsigned channel, uint32_t values[8]);
bool hw_pwm_ready(unsigned channel);
void hw_pwm_config(unsigned channel, unsigned timer, unsigned divider, unsigned bits, unsigned duty, bool reset_timer, bool first);
void hw_pwm_update(unsigned channel, unsigned duty);
void hw_pwm_release(unsigned channel, unsigned timer, bool last_timer, bool last);
