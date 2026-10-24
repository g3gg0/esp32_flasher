#pragma once
#include "protocol.h"
uint32_t rpc_peripheral_capabilities(void);
int rpc_peripheral_handle(const rpc_header_t *request, uint32_t length);
