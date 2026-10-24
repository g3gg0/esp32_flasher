/* Shared read-only DW-MSHC transactions for P4/S3. The port adapter supplies
 * target registers, DMA addressing and barriers; no RTOS/heap/flash dependency. */
#include "sdmmc.h"
#include "platform.h"
#if __has_include("sdkconfig.h")
#include "sdkconfig.h"
#endif

#if (defined(STUB_HAS_SDMMC) && STUB_HAS_SDMMC) || defined(RPC_SDMMC_TEST)
#include "sdmmc_port.h"

#define CMD_START (1u << 31)
#define DMA_ENABLE ((1u << 5) | (1u << 25))
#define DMA_OWN (1u << 31)
#define DATA_ERRORS ((1u << 7) | (1u << 9) | (1u << 10) | (1u << 11) | (1u << 13) | (1u << 15))
#define DMA_ERRORS ((1u << 2) | (1u << 4) | (1u << 5))
#define R1_ERRORS 0xfff9a008u

/* A separate NOLOAD section excludes DMA storage from BSS zeroing. The port
 * selects P4's uncached alias or S3's directly accessible internal SRAM. */
static struct {
    rpc_sdmmc_response_t reply;
    uint8_t data[512];
} dma_packet __attribute__((section(".dma"), aligned(64)));
static uint32_t dma_descriptor[16] __attribute__((section(".dma"), aligned(64)));
_Static_assert(offsetof(__typeof__(dma_packet), data) % 64 == 0, "SD DMA alignment");
_Static_assert(sizeof(dma_packet) <= RPC_MAX_PACKET_LENGTH, "SD sector packet fits");
static int configured, app_pending;

typedef struct { uint32_t start, budget; } deadline_t;
static deadline_t deadline(uint32_t us) {
    deadline_t d = { platform_cycles(), us * platform_ticks_per_us() };
    return d;
}
static int expired(deadline_t d) { return (uint32_t)(platform_cycles() - d.start) >= d.budget; }
static int wait_clear(uint32_t reg, uint32_t bits, deadline_t d) {
    do { if (!(SD_READ(reg) & bits)) return 1; } while (!expired(d));
    return 0;
}
static int stop_dma(deadline_t d) {
    SD_WRITE(SD_REG_CTRL, SD_READ(SD_REG_CTRL) & ~DMA_ENABLE);
    SD_WRITE(SD_REG_BMOD, 0);
    SD_WRITE(SD_REG_CTRL, SD_READ(SD_REG_CTRL) | 6);
    return wait_clear(SD_REG_CTRL, 6, d);
}
static uint32_t fail(rpc_sdmmc_response_t *out, uint32_t status, uint32_t sd_error) {
    out->status = status; out->sd_error = sd_error;
    return 0;
}
static int valid_command(const rpc_sdmmc_command_t *cmd) {
    unsigned type = RPC_SDMMCRESPONSETYPES_NONE;
    if (cmd->application > 1 || (cmd->application && !app_pending)) return 0;
    if (app_pending && !cmd->application && cmd->command != 0) return 0;
    if (cmd->application) {
        if (cmd->command == 6 && (cmd->argument == 0 || cmd->argument == 2)) type = RPC_SDMMCRESPONSETYPES_R1;
        else if (cmd->command == 41 && !(cmd->argument & ~0x40ff8000u)) type = RPC_SDMMCRESPONSETYPES_R3;
        else return 0;
    } else switch (cmd->command) {
        case 0: if (cmd->argument) return 0; break;
        case 2: if (cmd->argument) return 0; type = RPC_SDMMCRESPONSETYPES_R2; break;
        case 3: if (cmd->argument) return 0; type = RPC_SDMMCRESPONSETYPES_R6; break;
        case 7: if (cmd->argument & 0xffff) return 0; type = cmd->argument ? RPC_SDMMCRESPONSETYPES_R1B : RPC_SDMMCRESPONSETYPES_NONE; break;
        case 8: if (cmd->argument != 0x1aa) return 0; type = RPC_SDMMCRESPONSETYPES_R7; break;
        case 9: if (cmd->argument & 0xffff) return 0; type = RPC_SDMMCRESPONSETYPES_R2; break;
        case 13: case 55: if (cmd->argument & 0xffff) return 0; type = RPC_SDMMCRESPONSETYPES_R1; break;
        case 16: if (cmd->argument != 512) return 0; type = RPC_SDMMCRESPONSETYPES_R1; break;
        case 17: type = RPC_SDMMCRESPONSETYPES_R1; break;
        default: return 0; /* No card-write, erase, vendor or voltage-switch commands. */
    }
    return cmd->response_type == type && cmd->data_bytes == (cmd->command == 17 ? 512 : 0);
}
static int prepare_dma(deadline_t d) {
    if (!stop_dma(d)) return 0;
    SD_WRITE(SD_REG_BMOD, 1);
    if (!wait_clear(SD_REG_BMOD, 1, d)) return 0;
    volatile uint32_t *desc = SD_UNCACHED(dma_descriptor);
    desc[1] = 512;
    desc[2] = SD_DMA_ADDRESS(dma_packet.data);
    desc[3] = 0;
    desc[0] = DMA_OWN | 0x1e; /* chained, first, last, disable interrupt */
    SD_BARRIER();
    SD_WRITE(SD_REG_BLKSIZ, 512);
    SD_WRITE(SD_REG_BYTCNT, 512);
    SD_WRITE(SD_REG_FIFOTH, 1); /* single DMA word per request */
    SD_WRITE(SD_REG_IDSTS, 0x3ff);
    SD_WRITE(SD_REG_IDINTEN, 0);
    SD_WRITE(SD_REG_DBADDR, SD_DMA_ADDRESS(dma_descriptor));
    SD_WRITE(SD_REG_BMOD, 0x82);
    SD_WRITE(SD_REG_CTRL, SD_READ(SD_REG_CTRL) | DMA_ENABLE);
    SD_WRITE(SD_REG_PLDMND, 1);
    return 1;
}
static void capture_dma(rpc_sdmmc_response_t *out) {
    SD_BARRIER();
    volatile uint32_t *desc = SD_UNCACHED(dma_descriptor);
    out->descriptor = desc[0];
    out->transferred = SD_READ(SD_REG_TBBCNT);
    out->dma_status = SD_READ(SD_REG_IDSTS);
    out->data_events = SD_READ(SD_REG_RINTSTS);
}
static uint32_t transaction(const rpc_sdmmc_command_t *cmd, rpc_sdmmc_response_t *out, deadline_t d) {
    uint32_t flags = CMD_START | (1u << 29) | (1u << 16) | cmd->command;
    flags |= cmd->command == 0 ? 1u << 15 : 1u << 13;
    if (cmd->response_type != RPC_SDMMCRESPONSETYPES_NONE) flags |= 1u << 6;
    if (cmd->response_type == RPC_SDMMCRESPONSETYPES_R2) flags |= 1u << 7;
    if (cmd->response_type != RPC_SDMMCRESPONSETYPES_NONE && cmd->response_type != RPC_SDMMCRESPONSETYPES_R3) flags |= 1u << 8;
    if (cmd->data_bytes) flags |= 1u << 9;
    app_pending = 0;
    if (!wait_clear(SD_REG_CMD, CMD_START, d)) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_COMMAND_TIMEOUT);
    if (cmd->data_bytes && !prepare_dma(d)) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_DMA);
    SD_WRITE(SD_REG_RINTSTS, 0xffff);
    if (SD_READ(SD_REG_RINTSTS) & (4 | 2 | 64 | 256 | 4096 | 8 | DATA_ERRORS)) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_HOST);
    SD_WRITE(SD_REG_CMDARG, cmd->argument);
    SD_WRITE(SD_REG_CMD, flags);
    if (!wait_clear(SD_REG_CMD, CMD_START, d)) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_COMMAND_TIMEOUT);
    do {
        out->events = SD_READ(SD_REG_RINTSTS);
        if (out->events & (4 | 2 | 256 | 4096 | ((flags & (1u << 8)) ? 64 : 0))) break;
        if (expired(d)) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_COMMAND_TIMEOUT);
    } while (1);
    if (out->events & 256) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_RESPONSE_TIMEOUT);
    if (out->events & (2 | 4096)) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_HOST);
    if ((flags & (1u << 8)) && (out->events & 64)) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_RESPONSE_CRC);
    if (!(out->events & 4)) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_HOST);
    if (cmd->response_type != RPC_SDMMCRESPONSETYPES_NONE) out->response0 = SD_READ(SD_REG_RESP0);
    if (cmd->response_type == RPC_SDMMCRESPONSETYPES_R2) {
        out->response1 = SD_READ(SD_REG_RESP1); out->response2 = SD_READ(SD_REG_RESP2); out->response3 = SD_READ(SD_REG_RESP3);
    }
    if (((cmd->response_type == RPC_SDMMCRESPONSETYPES_R1 || cmd->response_type == RPC_SDMMCRESPONSETYPES_R1B) && (out->response0 & R1_ERRORS)) ||
        (cmd->response_type == RPC_SDMMCRESPONSETYPES_R6 && (out->response0 & 0xe000))) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_CARD_STATUS);
    if (cmd->command == 55) app_pending = !!(out->response0 & 32);
    if (cmd->response_type == RPC_SDMMCRESPONSETYPES_R1B && !wait_clear(SD_REG_STATUS, 1u << 9, d)) return fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_BUSY_TIMEOUT);
    if (!cmd->data_bytes) return 0;
    do {
        capture_dma(out);
        if (out->data_events & DATA_ERRORS) return fail(out, RPC_STATUS_IO_ERROR, out->data_events & 128 ? RPC_SDMMCERRORS_DATA_CRC : RPC_SDMMCERRORS_DATA_TIMEOUT);
        if ((out->dma_status & DMA_ERRORS) || (out->descriptor & (1u << 30))) return fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_DMA);
        if ((out->data_events & 8) && !(out->descriptor & DMA_OWN) && out->transferred == 512) return 512;
        if (expired(d)) return fail(out, RPC_STATUS_TIMEOUT, out->data_events & 8 ? RPC_SDMMCERRORS_SHORT_DATA : RPC_SDMMCERRORS_DATA_TIMEOUT);
    } while (1);
}

uint32_t rpc_sdmmc_capabilities(void) { return 1u << RPC_CAPABILITIES_SDMMC; }
int rpc_sdmmc_handle(const rpc_header_t *request, uint32_t length) {
    const rpc_module_command_t *base = (const void *)request;
    rpc_sdmmc_response_t *out = SD_UNCACHED(&dma_packet.reply);
    volatile uint8_t *bytes = (void *)out;
    for (unsigned i = 0; i < sizeof(*out); ++i) bytes[i] = 0;
    for (unsigned i = 0; i < 4; ++i) out->header.magic[i] = "SDMR"[i];
    uint32_t data_length = 0;
    if (length < sizeof(*base)) { fail(out, RPC_STATUS_BAD_LENGTH, 0); goto reply; }
    out->operation = base->operation; out->port = base->port;
    if (base->port != 1 || base->timeout_us < 100 || base->timeout_us > 1500000) { fail(out, RPC_STATUS_BAD_ARGUMENT, 0); goto reply; }
    deadline_t d = deadline(base->timeout_us);
    if (base->operation == RPC_OPERATIONS_CONFIGURE || base->operation == RPC_OPERATIONS_RELEASE) {
        if (length != sizeof(*base)) { fail(out, RPC_STATUS_BAD_LENGTH, 0); goto reply; }
        if (base->operation == RPC_OPERATIONS_CONFIGURE) {
            if (!(SD_READ(SD_REG_CLKENA) & 2)) { fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_NOT_CONFIGURED); goto reply; }
            configured = 1;
        }
        if (configured && !stop_dma(d)) fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_DMA);
        app_pending = 0;
        configured = base->operation == RPC_OPERATIONS_CONFIGURE && !out->status;
    } else if (base->operation == RPC_OPERATIONS_TRANSFER) {
        if (length != sizeof(rpc_sdmmc_command_t)) { fail(out, RPC_STATUS_BAD_LENGTH, 0); goto reply; }
        const rpc_sdmmc_command_t *cmd = (const void *)request;
        out->command = cmd->command; out->response_type = cmd->response_type; out->argument = cmd->argument;
        if (!configured) { fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_NOT_CONFIGURED); goto reply; }
        if (!valid_command(cmd)) { fail(out, RPC_STATUS_BAD_ARGUMENT, 0); goto reply; }
        data_length = transaction(cmd, out, d);
        if (cmd->data_bytes) {
            capture_dma(out);
            if (!stop_dma(deadline(10000))) { configured = 0; fail(out, RPC_STATUS_TIMEOUT, RPC_SDMMCERRORS_DMA); }
            out->data_events |= SD_READ(SD_REG_RINTSTS);
            if (!out->status && data_length && ((out->data_events & DATA_ERRORS) || (out->dma_status & DMA_ERRORS) || (out->descriptor & 0xc0000000u) || out->transferred != 512)) fail(out, RPC_STATUS_IO_ERROR, RPC_SDMMCERRORS_DMA);
            if (out->status) data_length = 0;
        }
    } else fail(out, RPC_STATUS_UNSUPPORTED, 0);
reply:
    out->header.length = sizeof(*out) + data_length;
    rpc_send(out, out->header.length);
    return 1;
}
#else
uint32_t rpc_sdmmc_capabilities(void) { return 0; }
int rpc_sdmmc_handle(const rpc_header_t *request, uint32_t length) { (void)request; (void)length; return 0; }
#endif
