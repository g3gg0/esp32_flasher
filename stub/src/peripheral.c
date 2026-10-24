/* One bounded RPC/state-machine implementation for all chip families.
 * Hardware access lives in peripheral_port.c and ESP-IDF's target LL headers. */
#include "peripheral.h"
#include "peripheral_port.h"
#include "platform.h"
#include "sdmmc.h"
#if (defined(STUB_HAS_PERIPHERALS) && STUB_HAS_PERIPHERALS) || defined(RPC_PERIPHERAL_TEST)
static struct { rpc_peripheral_response_t reply; uint8_t data[64]; } packet;
static struct { uint32_t hz; uint8_t active; } i2c_state[2], spi_state[2];
static struct { uint32_t hz, divider; uint8_t bits, users; } timers[4];
static struct { uint8_t active, timer, bits; } channels[8];
typedef struct { uint32_t start, budget; } io_deadline_t;
static io_deadline_t deadline(uint32_t us) { io_deadline_t d = { platform_cycles(), us * platform_ticks_per_us() }; return d; }
static bool expired(io_deadline_t d) { return (uint32_t)(platform_cycles() - d.start) >= d.budget; }
static unsigned fail(unsigned status, unsigned error) { packet.reply.status = status; packet.reply.error = error; return 0; }
static unsigned io_fail(unsigned error) { return fail(error == RPC_PERIPHERALERRORS_TIMEOUT ? RPC_STATUS_TIMEOUT : RPC_STATUS_IO_ERROR, error); }
static int i2c_wait(unsigned port, unsigned last, io_deadline_t d) {
    int event;
    do { event = hw_i2c_poll(port, last); if (event) return event; } while (!expired(d));
    return -(int)RPC_PERIPHERALERRORS_TIMEOUT;
}
static unsigned i2c(const rpc_peripheral_command_t *q, const uint8_t *data, unsigned length) {
    unsigned port = q->port;
    if (port >= hw_i2c_count() || port >= 2) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_PORT);
    if (q->operation == RPC_OPERATIONS_INFO) {
        uint32_t values[8]; hw_i2c_info(port, values);
        for (unsigned i = 0; i < 8; ++i) packet.reply.values[i] = values[i];
        packet.reply.actual_hz = hw_i2c_clock(); return 0;
    }
    if (q->operation == RPC_OPERATIONS_RELEASE) {
        if (i2c_state[port].active) hw_i2c_release(port);
        i2c_state[port].active = 0; return 0;
    }
    if (q->operation == RPC_OPERATIONS_CONFIGURE) {
        if (length) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_TRANSFER);
        if (q->args[0] != 100000 && q->args[0] != 400000) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_SPEED);
        if (!hw_i2c_clock()) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_CLOCK);
        hw_i2c_config(port, q->args[0]); i2c_state[port].active = 1;
        packet.reply.actual_hz = i2c_state[port].hz = q->args[0]; return 0;
    }
    if (q->operation != RPC_OPERATIONS_TRANSFER) return fail(RPC_STATUS_UNSUPPORTED, 0);
    if (!i2c_state[port].active) return io_fail(RPC_PERIPHERALERRORS_NOT_CONFIGURED);
    unsigned address = q->args[0], write = q->args[1], read = q->args[2];
    unsigned tx_count = write + ((write || !read) ? 1 : 0) + (read ? 1 : 0);
    if (address > 127 || write != length || read > hw_i2c_fifo() || tx_count > hw_i2c_fifo()) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_TRANSFER);
    io_deadline_t d = deadline(q->timeout_us);
    while (!hw_i2c_idle(port)) if (expired(d)) return io_fail(RPC_PERIPHERALERRORS_TIMEOUT);
    io_i2c_cmd_t cmds[8]; uint8_t tx[32]; unsigned n = 0, pos = 0;
#define CMD(opcode, num, check, value) do { cmds[n++] = (io_i2c_cmd_t){opcode, num, check, value}; } while (0)
    if (write || !read) {
        CMD(IO_START, 0, 0, 0); tx[pos++] = address << 1;
        for (unsigned i = 0; i < write; ++i) tx[pos++] = data[i];
        CMD(IO_WRITE, write + 1, 1, 0);
    }
    if (read) {
        CMD(IO_START, 0, 0, 0); tx[pos++] = (address << 1) | 1;
        CMD(IO_WRITE, 1, 1, 0);
        if (read > 1) CMD(IO_READ, read - 1, 0, 0);
        CMD(IO_READ, 1, 0, 1);
    }
    CMD(IO_STOP, 0, 0, 0);
#undef CMD
    hw_i2c_begin(port, cmds, n, tx, pos);
    int event = i2c_wait(port, n - 1, d);
    packet.reply.values[0] = n; packet.reply.actual_hz = i2c_state[port].hz;
    if (event < 0) {
        unsigned error = -event;
        if (error == RPC_PERIPHERALERRORS_NACK) {
            hw_i2c_stop_begin(port);
            io_deadline_t recovery = deadline(25000);
            /* IDF waits for BUS_BUSY after NACK, not a new completion IRQ.
             * The NACK can stay latched and STOP need not raise TRANS_COMPLETE. */
            while (!hw_i2c_idle(port)) if (expired(recovery)) { error = RPC_PERIPHERALERRORS_BUS; break; }
        }
        hw_i2c_config(port, i2c_state[port].hz);
        return io_fail(error);
    }
    if (hw_i2c_read(port, packet.data, read) != read) return io_fail(RPC_PERIPHERALERRORS_SHORT_DATA);
    return read;
}
static unsigned spi(const rpc_peripheral_command_t *q, const uint8_t *data, unsigned length) {
    unsigned port = q->port;
    if (port < 1 || port > hw_spi_count() || port > 2) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
    unsigned index = port - 1;
    if (q->operation == RPC_OPERATIONS_INFO) {
        uint32_t values[8]; hw_spi_info(port, values);
        for (unsigned i = 0; i < 8; ++i) packet.reply.values[i] = values[i];
        packet.reply.actual_hz = hw_spi_clock(); return 0;
    }
    if (q->operation == RPC_OPERATIONS_RELEASE) {
        if (spi_state[index].active) hw_spi_release(port);
        spi_state[index].active = 0; return 0;
    }
    if (q->operation == RPC_OPERATIONS_CONFIGURE) {
        if (length || !q->args[0] || q->args[0] > 20000000 || q->args[1] > 3 || q->args[2] > 1 || !hw_spi_clock()) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
        packet.reply.actual_hz = hw_spi_config(port, q->args[0], q->args[1], q->args[2]);
        spi_state[index].hz = packet.reply.actual_hz; spi_state[index].active = !!packet.reply.actual_hz;
        return packet.reply.actual_hz ? 0 : fail(RPC_STATUS_BAD_ARGUMENT, 0);
    }
    if (q->operation != RPC_OPERATIONS_TRANSFER) return fail(RPC_STATUS_UNSUPPORTED, 0);
    if (!spi_state[index].active) return io_fail(RPC_PERIPHERALERRORS_NOT_CONFIGURED);
    if (!length || length > 64 || q->args[0] != length) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
    io_deadline_t d = deadline(q->timeout_us);
    if (!hw_spi_begin(port, data, length, q->timeout_us)) {
        hw_spi_release(port); spi_state[index].active = 0;
        return io_fail(RPC_PERIPHERALERRORS_TIMEOUT);
    }
    while (!hw_spi_done(port)) if (expired(d)) {
        hw_spi_release(port); spi_state[index].active = 0;
        return io_fail(RPC_PERIPHERALERRORS_TIMEOUT);
    }
    hw_spi_read(port, packet.data, length); packet.reply.actual_hz = spi_state[index].hz;
    return length;
}
static unsigned pwm(const rpc_peripheral_command_t *q, unsigned length) {
    unsigned channel = q->port;
    if (channel >= hw_pwm_count() || channel >= 8 || length) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
    if (q->operation == RPC_OPERATIONS_INFO) {
        uint32_t values[8]; hw_pwm_info(channel, values);
        for (unsigned i = 0; i < 8; ++i) packet.reply.values[i] = values[i];
        packet.reply.actual_hz = hw_pwm_clock(); return 0;
    }
    unsigned active = 0; for (unsigned i = 0; i < 8; ++i) active |= channels[i].active << i;
    if (q->operation == RPC_OPERATIONS_RELEASE) {
        if (channels[channel].active) {
            unsigned t = channels[channel].timer;
            timers[t].users &= ~(1u << channel);
            hw_pwm_release(channel, t, !timers[t].users, !(active & ~(1u << channel)));
            channels[channel].active = 0;
        }
        return 0;
    }
    if (q->operation != RPC_OPERATIONS_CONFIGURE && q->operation != RPC_OPERATIONS_TRANSFER) return fail(RPC_STATUS_UNSUPPORTED, 0);
    if (q->operation == RPC_OPERATIONS_TRANSFER && !channels[channel].active) return io_fail(RPC_PERIPHERALERRORS_NOT_CONFIGURED);
    unsigned t = q->operation == RPC_OPERATIONS_CONFIGURE ? q->args[2] : channels[channel].timer;
    unsigned duty = q->operation == RPC_OPERATIONS_CONFIGURE ? q->args[3] : q->args[0];
    if (t >= hw_pwm_timers() || t >= 4 || duty > 1000) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
    io_deadline_t d = deadline(q->timeout_us);
    if (channels[channel].active) while (!hw_pwm_ready(channel)) if (expired(d)) return io_fail(RPC_PERIPHERALERRORS_TIMEOUT);
    if (q->operation == RPC_OPERATIONS_CONFIGURE) {
        unsigned hz = q->args[0], bits = q->args[1]; uint32_t source = hw_pwm_clock();
        if (!hz || !bits || bits > hw_pwm_max_bits() || !source || (channels[channel].active && channels[channel].timer != t)) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
        uint64_t div = (((uint64_t)source << 8) + ((uint64_t)hz << (bits - 1))) / ((uint64_t)hz << bits);
        if (div < 256 || div > 0x3ffff) return fail(RPC_STATUS_BAD_ARGUMENT, 0);
        if ((timers[t].users & ~(1u << channel)) && (timers[t].divider != div || timers[t].bits != bits)) return fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_TIMER_CONFLICT);
        hw_pwm_config(channel, t, div, bits, ((1u << bits) * duty) / 1000, !(timers[t].users & ~(1u << channel)), !active);
        timers[t].hz = ((uint64_t)source << 8) / (div << bits); timers[t].divider = div; timers[t].bits = bits; timers[t].users |= 1u << channel;
        channels[channel].active = 1; channels[channel].timer = t; channels[channel].bits = bits;
    } else hw_pwm_update(channel, ((1u << channels[channel].bits) * duty) / 1000);
    packet.reply.actual_hz = timers[t].hz; packet.reply.values[0] = duty; packet.reply.values[1] = timers[t].bits; packet.reply.values[2] = t;
    return 0;
}
uint32_t rpc_peripheral_capabilities(void) { return (1u << RPC_CAPABILITIES_I2C) | (1u << RPC_CAPABILITIES_SPI) | (1u << RPC_CAPABILITIES_PWM); }
int rpc_peripheral_handle(const rpc_header_t *request, uint32_t length) {
    const uint8_t *magic = request->magic;
    bool is_i2c = magic[0] == 'I' && magic[1] == '2' && magic[2] == 'C' && magic[3] == 'C';
    bool is_spi = magic[0] == 'S' && magic[1] == 'P' && magic[2] == 'I' && magic[3] == 'C';
    bool is_pwm = magic[0] == 'P' && magic[1] == 'W' && magic[2] == 'M' && magic[3] == 'C';
    if (!is_i2c && !is_spi && !is_pwm) return 0;
    uint8_t *clear = (void *)&packet.reply; for (unsigned i = 0; i < sizeof(packet.reply); ++i) clear[i] = 0;
    for (unsigned i = 0; i < 3; ++i) packet.reply.header.magic[i] = magic[i];
    packet.reply.header.magic[3] = 'R';
    unsigned result = 0;
    if (length < sizeof(rpc_peripheral_command_t)) fail(RPC_STATUS_BAD_LENGTH, 0);
    else {
        const rpc_peripheral_command_t *q = (const void *)request;
        packet.reply.operation = q->operation; packet.reply.port = q->port;
        unsigned bytes = length - sizeof(*q);
        if (q->timeout_us < 100 || q->timeout_us > 1500000) fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_TIMEOUT);
        else if (q->operation != RPC_OPERATIONS_TRANSFER && bytes) fail(RPC_STATUS_BAD_ARGUMENT, RPC_PERIPHERALERRORS_BAD_TRANSFER);
        else if (is_i2c) result = i2c(q, (const uint8_t *)(q + 1), bytes);
        else if (is_spi) result = spi(q, (const uint8_t *)(q + 1), bytes);
        else result = pwm(q, bytes);
    }
    packet.reply.header.length = sizeof(packet.reply) + result;
    rpc_send(&packet, packet.reply.header.length);
    return 1;
}
#else
uint32_t rpc_peripheral_capabilities(void) { return 0; }
int rpc_peripheral_handle(const rpc_header_t *request, uint32_t length) { (void)request; (void)length; return 0; }
#endif
