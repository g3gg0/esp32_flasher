#pragma once
#include "protocol.h"
uint32_t rpc_sdmmc_capabilities(void);
int rpc_sdmmc_handle(const rpc_header_t *request, uint32_t length);
void rpc_send(const void *packet, uint32_t length);
