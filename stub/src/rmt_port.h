#pragma once
#include <stdint.h>
unsigned hw_rmt_count(void);
unsigned hw_rmt_words(void);
uint32_t hw_rmt_cpu_hz(void);
void hw_rmt_info(unsigned channel,uint32_t values[8]);
uint32_t hw_rmt_config(unsigned channel,unsigned hz,unsigned idle);
void hw_rmt_prepare(unsigned channel);
void hw_rmt_write(unsigned channel,unsigned offset,uint32_t symbol);
void hw_rmt_start(unsigned channel);
unsigned hw_rmt_events(unsigned channel); /* done=1 threshold=2 error=4 */
void hw_rmt_clear(unsigned channel,unsigned events);
void hw_rmt_stop(unsigned channel);
void hw_rmt_release(unsigned channel);
