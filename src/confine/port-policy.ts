/**
 * macOS's own services, whoever runs the Mac: ssh, screen sharing, Remote Management, Remote Apple
 * Events, SMB and AFP file sharing, printing (decision D5, review R8). Nothing particular to one
 * person's Mac belongs here: their own services go in never.ports, or are caught by the snapshot.
 */
export const STATIC_DENIED_TCP: readonly number[] = [22, 5900, 3283, 3031, 445, 548, 631];
/** SSDP/UPnP and NAT-PMP/PCP mappings, denied to every host. */
export const STATIC_DENIED_UDP: readonly number[] = [1900, 5351];
