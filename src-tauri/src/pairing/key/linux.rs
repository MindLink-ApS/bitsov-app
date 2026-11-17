use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase { TempSynced, Verified, Published, Durable, BeforeCleanup, Complete }

fn load(dir: &Path, sealer: Option<&dyn Sealer>) -> Result<ClientKey, PairError> {
    load_with(dir, sealer, &mut |_| Ok(()))
}

fn load_with(
    dir: &Path,
    sealer: Option<&dyn Sealer>,
    _checkpoint: &mut dyn FnMut(Phase) -> Result<(), PairError>,
) -> Result<ClientKey, PairError> {
    let sealer = at_rest::linux::required(sealer).map_err(PairError::Local)?;
    ClientKey::load_or_create_sealed(dir, &sealer)
}

mod tests;
