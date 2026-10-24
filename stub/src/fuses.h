#pragma once
#include "protocol.h"
uint32_t rpc_fuses_capabilities(void);
int rpc_fuses_handle(const rpc_header_t *request,uint32_t length);
