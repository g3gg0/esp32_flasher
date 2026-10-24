#include <stdint.h>
#include "protocol.h"
#include "platform.h"
#include "sdmmc.h"

extern uint8_t _bss_start[], _bss_end[];
static uint8_t rx_buffer[RPC_MAX_PACKET_LENGTH] __attribute__((aligned(4)));
static uint32_t rx_size;
static int rx_started, rx_escaped, rx_malformed;

/* Freestanding aggregate initialization can emit memset even with -fno-builtin. */
void *memset(void *dest, int value, size_t size) {
    uint8_t *p = dest;
    for (size_t i = 0; i < size; ++i) p[i] = (uint8_t)value;
    return dest;
}

static int magic_is(const void *packet, const char *magic) {
    const uint8_t *p = packet;
    return p[0] == magic[0] && p[1] == magic[1] && p[2] == magic[2] && p[3] == magic[3];
}
static void set_header(rpc_header_t *header, const char *magic, uint32_t length) {
    for (unsigned i = 0; i < 4; ++i) header->magic[i] = magic[i];
    header->length = length;
}
static void tx_escaped(uint8_t byte) {
    if (byte == 0xc0 || byte == 0xdb) {
        platform_tx(0xdb); platform_tx(byte == 0xc0 ? 0xdc : 0xdd);
    } else platform_tx(byte);
}
void rpc_send(const void *packet, uint32_t length) {
    const uint8_t *p = packet;
    platform_tx(0xc0);
    for (uint32_t i = 0; i < length; ++i) tx_escaped(p[i]);
    platform_tx(0xc0); platform_flush();
}
static void error(const rpc_header_t *request, uint32_t status) {
    rpc_error_t response;
    set_header(&response.header, RPC_MAGIC_ERROR, sizeof(response));
    for (unsigned i = 0; i < 4; ++i) response.request_magic[i] = request->magic[i];
    response.status = status;
    rpc_send(&response, sizeof(response));
}
static void dispatch(uint32_t size, int malformed) {
    rpc_header_t *header = (void *) rx_buffer;
    if (size < sizeof(*header)) {
        /* A short frame still gets one structured error, zero-padding its tag. */
        for (uint32_t i = size; i < sizeof(*header); ++i) rx_buffer[i] = 0;
        error(header, RPC_STATUS_BAD_LENGTH); return;
    }
    if (malformed || size != header->length || size > RPC_MAX_PACKET_LENGTH) {
        error(header, RPC_STATUS_BAD_LENGTH); return;
    }
    if (magic_is(header, RPC_MAGIC_SYNC)) {
        if (size != sizeof(rpc_sync_t)) { error(header, RPC_STATUS_BAD_LENGTH); return; }
        rpc_identity_t id = {0};
        set_header(&id.header, RPC_MAGIC_IDENTITY, sizeof(id));
        id.protocol_major = RPC_PROTOCOL_MAJOR; id.protocol_minor = RPC_PROTOCOL_MINOR;
        id.max_packet_length = RPC_MAX_PACKET_LENGTH;
        id.capabilities = (1u << RPC_CAPABILITIES_REGISTERS) | rpc_sdmmc_capabilities();
        platform_identity(&id); rpc_send(&id, sizeof(id)); return;
    }
    if (magic_is(header, RPC_MAGIC_REGISTER_COMMAND)) {
        if (size != sizeof(rpc_register_command_t)) { error(header, RPC_STATUS_BAD_LENGTH); return; }
        const rpc_register_command_t *cmd = (void *) rx_buffer;
        rpc_register_response_t response = {0};
        set_header(&response.header, RPC_MAGIC_REGISTER_RESPONSE, sizeof(response));
        if (cmd->operation > RPC_REGISTEROPERATIONS_WRITE || cmd->delay_us > RPC_MAX_REGISTER_DELAY_US || !platform_register_allowed(cmd->address, cmd->operation == RPC_REGISTEROPERATIONS_WRITE)) {
            response.status = RPC_STATUS_BAD_ARGUMENT;
        } else {
            volatile uint32_t *reg = (void *)(uintptr_t) cmd->address;
            if (cmd->operation == RPC_REGISTEROPERATIONS_WRITE) {
                *reg = cmd->mask == UINT32_MAX ? cmd->value : (*reg & ~cmd->mask) | (cmd->value & cmd->mask);
                if (cmd->delay_us) platform_delay(cmd->delay_us);
            } else response.value = *reg;
        }
        rpc_send(&response, sizeof(response)); return;
    }
    if (magic_is(header, "SDMC") && rpc_sdmmc_handle(header, size)) return;
#define MODULE_CASE(name, command, reply) \
    if (magic_is(header, command)) { \
        if (size < sizeof(rpc_module_command_t)) { error(header, RPC_STATUS_BAD_LENGTH); return; } \
        const rpc_module_command_t *cmd = (void *) rx_buffer; \
        rpc_module_response_t response; \
        set_header(&response.header, reply, sizeof(response)); \
        response.status = RPC_STATUS_UNSUPPORTED; response.operation = cmd->operation; response.port = cmd->port; \
        rpc_send(&response, sizeof(response)); return; \
    }
    RPC_MODULES(MODULE_CASE)
#undef MODULE_CASE
    error(header, RPC_STATUS_UNSUPPORTED);
}

void rpc_receive_byte(uint8_t byte) {
    if (byte == 0xc0) {
        if (rx_started && (rx_size || rx_malformed || rx_escaped)) dispatch(rx_size, rx_malformed || rx_escaped);
        rx_size = 0; rx_escaped = 0; rx_malformed = 0; rx_started = 1;
    } else if (rx_started) {
        if (rx_escaped) {
            if (byte == 0xdc) byte = 0xc0;
            else if (byte == 0xdd) byte = 0xdb;
            else rx_malformed = 1;
            rx_escaped = 0;
        } else if (byte == 0xdb) { rx_escaped = 1; return; }
        if (rx_size < sizeof(rx_buffer)) rx_buffer[rx_size++] = byte;
        else rx_malformed = 1;
    }
}

void __attribute__((noreturn)) stub_main(void) {
    for (uint8_t *p = _bss_start; p < _bss_end; ++p) *p = 0;
    platform_init();
    for (;;) {
        uint8_t byte;
        if (!platform_rx(&byte)) rpc_receive_byte(byte);
    }
}
