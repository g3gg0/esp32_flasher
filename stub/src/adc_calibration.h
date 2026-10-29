#pragma once
#include "protocol.h"
unsigned capture_adc_initialize(const rpc_header_t *request,uint32_t length,uint32_t codes[2],uint32_t *version);
unsigned capture_adc_release(void);
unsigned capture_adc_ready(void);
unsigned capture_adc_failure_slot(void);
int capture_adc_prepare_channel(uint32_t address,uint32_t value,uint32_t mask);
