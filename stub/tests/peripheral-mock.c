#include <stdlib.h>
#include <string.h>
#include "peripheral_port.h"
#include "protocol.h"
static uint8_t spi_data[64];
static unsigned rx_count, i2c_error;
static int mode(const char *name) { const char *m = getenv("IO_TEST_MODE"); return m && !strcmp(m, name); }
unsigned hw_i2c_count(void) { return 2; }
unsigned hw_i2c_fifo(void) { return mode("fifo16") ? 16 : 32; }
uint32_t hw_i2c_clock(void) { return 40000000; }
void hw_i2c_info(unsigned p, uint32_t v[8]) { (void)p; for (unsigned i=0;i<8;i++) v[i]=0; v[5]=hw_i2c_fifo(); v[6]=2; }
void hw_i2c_config(unsigned p, unsigned speed) { (void)p; (void)speed; }
void hw_i2c_release(unsigned p) { (void)p; }
bool hw_i2c_idle(unsigned p) { (void)p; return !mode("busy"); }
void hw_i2c_begin(unsigned p, const io_i2c_cmd_t *cmds, unsigned count, const uint8_t *tx, unsigned size) {
    (void)p; (void)tx; (void)size; rx_count=0; i2c_error=0;
    if (!count || cmds[count-1].op != IO_STOP) abort();
    for (unsigned i=0;i<count;i++) if (cmds[i].op==IO_READ) {
        rx_count+=cmds[i].count;
        if ((i+1==count-1 && (!cmds[i].nack || cmds[i].count!=1)) || (i+1<count-1 && cmds[i].nack)) abort();
    }
    if (mode("nack") && count>1) i2c_error=RPC_PERIPHERALERRORS_NACK;
    if (mode("arbitration")) i2c_error=RPC_PERIPHERALERRORS_ARBITRATION;
}
int hw_i2c_poll(unsigned p, unsigned last) { (void)p; (void)last; return mode("timeout") ? 0 : i2c_error ? -(int)i2c_error : 1; }
unsigned hw_i2c_read(unsigned p, uint8_t *data, unsigned size) { (void)p; if (mode("short")) return size+1; if(size!=rx_count) abort(); for(unsigned i=0;i<size;i++) data[i]=0xa0+i; return size; }
unsigned hw_spi_count(void) { return 2; }
uint32_t hw_spi_clock(void) { return 40000000; }
void hw_spi_info(unsigned p, uint32_t v[8]) { (void)p; for(unsigned i=0;i<8;i++)v[i]=0; v[5]=2; v[6]=64; }
uint32_t hw_spi_config(unsigned p, unsigned hz, unsigned m, bool lsb) { (void)p; (void)m; (void)lsb; return hz; }
void hw_spi_release(unsigned p) { (void)p; }
bool hw_spi_begin(unsigned p, const uint8_t *data, unsigned size, unsigned timeout) { (void)p; (void)timeout; for(unsigned i=0;i<size;i++)spi_data[i]=data[i]^0xff; return !mode("applytimeout"); }
bool hw_spi_done(unsigned p) { (void)p; return !mode("timeout"); }
void hw_spi_read(unsigned p, uint8_t *data, unsigned size) { (void)p; for(unsigned i=0;i<size;i++)data[i]=spi_data[i]; }
unsigned hw_pwm_count(void) { return 8; }
unsigned hw_pwm_timers(void) { return 4; }
unsigned hw_pwm_max_bits(void) { return 19; }
uint32_t hw_pwm_clock(void) { return 40000000; }
void hw_pwm_info(unsigned p, uint32_t v[8]) { (void)p; for(unsigned i=0;i<8;i++)v[i]=0; v[1]=8; v[2]=4; v[3]=19; }
bool hw_pwm_ready(unsigned ch) { (void)ch; return !mode("timeout"); }
void hw_pwm_config(unsigned ch, unsigned t, unsigned div, unsigned bits, unsigned duty, bool reset, bool first) { (void)ch;(void)t;(void)div;(void)bits;(void)duty;(void)reset;(void)first; }
void hw_pwm_update(unsigned ch, unsigned duty) { (void)ch;(void)duty; }
void hw_pwm_release(unsigned ch, unsigned t, bool last_timer, bool last) { (void)ch;(void)t;(void)last_timer;(void)last; }
