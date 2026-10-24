#pragma once
#include "protocol.h"
uint32_t rpc_rmt_capabilities(void);
int rpc_rmt_handle(const rpc_header_t *request,uint32_t length);
