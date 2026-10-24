#pragma once
#include "protocol.h"
uint32_t rpc_flash_capabilities(void);
int rpc_flash_handle(const rpc_header_t *request, uint32_t length);
