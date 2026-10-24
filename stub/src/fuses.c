/* Device-defined named TLV records. Only public eFuse shadows are compiled in. */
#include "fuses.h"
#include "platform.h"
#include "sdmmc.h"
#if STUB_HAS_FUSES || defined(RPC_FUSES_TEST)
#ifndef RPC_FUSES_TEST
#include "sdkconfig.h"
#endif
#include "fuse-profiles.h"
#ifndef STUB_CHIP
#define STUB_CHIP "esp32c3"
#define STUB_CPU "riscv32"
#define STUB_CORES 1
#define STUB_IDF "6.1"
#endif
#define META_COUNT 14u
static struct { rpc_peripheral_response_t response; uint8_t data[512]; } packet;
static unsigned used,limit;
#ifdef RPC_FUSES_TEST
extern uint32_t hw_fuse_read(uint32_t address);
#else
static uint32_t hw_fuse_read(uint32_t address){return *(const volatile uint32_t *)(uintptr_t)address;}
#endif
static unsigned text_length(const char *text){unsigned n=0;while(text[n])n++;return n;}
static int append(const char *name,unsigned type,unsigned bits,const void *data,unsigned length){
    unsigned name_length=text_length(name),size=sizeof(rpc_fuse_record_t)+name_length+length;
    if(size>limit-used)return 0;
    rpc_fuse_record_t header={size,name_length,type,bits,length};
    const uint8_t *p=(const void *)&header;for(unsigned i=0;i<sizeof(header);i++)packet.data[used++]=p[i];
    for(unsigned i=0;i<name_length;i++)packet.data[used++]=name[i];
    p=data;for(unsigned i=0;i<length;i++)packet.data[used++]=p[i];return 1;
}
static unsigned decimal(char *p,unsigned n){char reverse[10];unsigned size=0;do{reverse[size++]='0'+n%10;n/=10;}while(n);for(unsigned i=0;i<size;i++)p[i]=reverse[size-1-i];return size;}
static int metadata(unsigned index){
    uint32_t number=0;const char *text=0,*name=0;unsigned type=RPC_FUSETYPES_UNSIGNED;char version[24];
    switch(index){
    case 0:name="CHIP.MODEL";text=STUB_CHIP;break;
    case 1:name="CHIP.CPU";text=STUB_CPU;break;
    case 2:name="CHIP.CORES";number=STUB_CORES;break;
    case 3:name="CHIP.CPU_HZ";number=platform_ticks_per_us()*1000000u;break;
    case 4:{name="CHIP.RESET_REASON";rpc_identity_t id={0};platform_identity(&id);number=id.reset_reason;break;}
    case 5:name="ROM.BASE";type=RPC_FUSETYPES_HEX;number=FUSE_ROM_BASE;break;
    case 6:name="ROM.CHIP_ID";if(FUSE_ROM_CHIP_ADDRESS)number=hw_fuse_read(FUSE_ROM_CHIP_ADDRESS);else text="not exposed";break;
    case 7:name="ROM.ECO_VERSION";if(FUSE_ROM_ECO_ADDRESS)number=hw_fuse_read(FUSE_ROM_ECO_ADDRESS);else text="not exposed";break;
    case 8:name="ROM.FLASH_LAYOUT";
#if CONFIG_IDF_TARGET_ESP32P4
        text=hw_fuse_read(FUSE_ROM_ECO_ADDRESS)>=5?"ECO5+":"ECO0-4";
#else
        text="standard";
#endif
        break;
    case 9:name="STUB.VERSION";text=RPC_BUILD_VERSION;break;
    case 10:{name="STUB.PROTOCOL";unsigned n=decimal(version,RPC_PROTOCOL_MAJOR);version[n++]='.';n+=decimal(version+n,RPC_PROTOCOL_MINOR);version[n]=0;text=version;break;}
    case 11:name="STUB.IDF";text=STUB_IDF;break;
    case 12:name="SCHEMA.SOURCE";text=FUSE_SOURCE;break;
    default:name="ROM.FLASH_DATA_SLOT";type=RPC_FUSETYPES_HEX;
#if CONFIG_IDF_TARGET_ESP32P4
        number=hw_fuse_read(FUSE_ROM_ECO_ADDRESS)>=5?0x4ffbffe8u:0x4ff3ffe8u;
#else
        text="not applicable";
#endif
        break;
    }
    return text?append(name,RPC_FUSETYPES_TEXT,0,text,text_length(text)):append(name,type,32,&number,4);
}
static int field(unsigned index){
    const fuse_field_t *f=&fuse_fields[index];uint8_t data[32]={0};unsigned position=0;
    for(unsigned i=0;i<f->count;i++){
        const fuse_piece_t *p=&fuse_pieces[f->first+i];uint32_t word=hw_fuse_read(fuse_words[p->word]);
        for(unsigned bit=0;bit<p->bits;bit++,position++)if(word&(1u<<(p->shift+bit)))data[position/8]|=1u<<(position%8);
    }
    return append(f->name,f->type,f->bits,data,(f->bits+7)/8);
}
uint32_t rpc_fuses_capabilities(void){return 1u<<RPC_CAPABILITIES_FUSES;}
int rpc_fuses_handle(const rpc_header_t *request,uint32_t length){
    if(request->magic[0]!='F'||request->magic[1]!='U'||request->magic[2]!='S'||request->magic[3]!='C')return 0;
    packet.response=(rpc_peripheral_response_t){0};packet.response.header=(rpc_header_t){{'F','U','S','R'},sizeof(packet.response)};
    if(length!=sizeof(rpc_peripheral_command_t)){packet.response.status=RPC_STATUS_BAD_LENGTH;goto done;}
    const rpc_peripheral_command_t *q=(const void *)request;packet.response.operation=q->operation;packet.response.port=q->port;
    unsigned total=META_COUNT+sizeof(fuse_fields)/sizeof(fuse_fields[0]);
    packet.response.values[3]=total;packet.response.values[7]=FUSE_SCHEMA_ID;
    if(q->port){packet.response.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
    if(q->operation==RPC_FUSEOPERATIONS_INFO){packet.response.values[0]=total;packet.response.values[1]=1;packet.response.values[2]=sizeof(packet.data);}
    else if(q->operation==RPC_FUSEOPERATIONS_READ){
        unsigned cursor=q->args[0];limit=q->args[1];used=0;
        if(cursor>=total||limit<192||limit>sizeof(packet.data)){packet.response.status=RPC_STATUS_BAD_ARGUMENT;goto done;}
        packet.response.values[0]=cursor;
        while(cursor<total){if(!(cursor<META_COUNT?metadata(cursor):field(cursor-META_COUNT)))break;cursor++;packet.response.values[1]++;}
        packet.response.values[2]=cursor;packet.response.header.length+=used;
    }else packet.response.status=RPC_STATUS_UNSUPPORTED;
done:rpc_send(&packet,packet.response.header.length);return 1;
}
#else
uint32_t rpc_fuses_capabilities(void){return 0;}
int rpc_fuses_handle(const rpc_header_t *request,uint32_t length){(void)request;(void)length;return 0;}
#endif
